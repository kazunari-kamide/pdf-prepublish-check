<?php
// SPDX-License-Identifier: AGPL-3.0-only
//
// お守りPDF のお問い合わせのフォームの送り先（手順は docs/contact.md）。
// npm run build のとき、site.ts がこのファイルに結果のページの HTML とヘッダーを差し込み、dist/contact-send.php として出す。
// dist/contact-send.php を直接書き換えない。
//
// 決まり（2026-11-05 本人が決定）：
// - 入力を、運営者へのメール 1 通にして届ける。ほかの会社のサービス（フォームの代行・reCAPTCHA・解析）には送らない
// - メールのヘッダー（宛先・件名・送信元）に、入力を入れない。入力は本文にだけ入れる（ヘッダー注入を防ぐ）
// - 同じサイトのページから送られたときだけ受け付ける（CSRF の対策。Sec-Fetch-Site か Origin で見る。Cookie は使わない）
// - 人には見えない欄が埋まっていたら、送ったふりをして、メールは出さない（ボットの対策）
// - 同じ接続元から続けて送れない。接続元は、元に戻せない形（鍵つきのハッシュ）にして、最長 24 時間だけ残す
// - 届け先などの本物の設定は、public_html の外の contact-config.php に置く（リポジトリには入れない。ひな形は server/contact-config.sample.php）
// - 動かすには PHP 8.0 以上が要る

declare(strict_types=1);

/** 種類。値（左）はフォームの value、名前（右）はメールの件名と本文に入れる。件名に入るのはこの決まった名前だけ */
const KINDS = ['question' => '質問', 'bug' => '不具合', 'security' => 'セキュリティの弱点', 'other' => 'その他'];
const BODY_MAX_CHARS = 4000;
const EMAIL_MAX_CHARS = 254;
const POST_MAX_BYTES = 65536;
/** 同じ接続元から：[何秒の間に, 何回まで] */
const LIMITS = [[60, 1], [3600, 5]];
/** サイト全体で、24 時間に何通まで（届け先のメールの箱をあふれさせないため） */
const DAILY_MAX = 50;
/** 迷惑防止の記録を残す長さ（秒） */
const KEEP_SECONDS = 86400;
const DEFAULT_ORIGIN = 'https://omamoripdf.com';
const MESSAGE_MARK = '<!--CONTACT_MESSAGE-->';

/** 結果のページ（'done'・'error'）。ビルドで差し込む */
$PAGES = []; // @@PAGES@@
/** 返すヘッダー（csp.ts の contactHeaders）。ビルドで差し込む */
$HEADERS = []; // @@HEADERS@@

/** 届け先などの本物の設定を読む。public_html（このファイルの置き場）の 1 つ上の contact-config.php */
function contact_load_config(): ?array
{
    $path = dirname(__DIR__) . '/contact-config.php';
    if (!is_file($path)) {
        return null;
    }
    $config = require $path;
    return is_array($config) ? $config : null;
}

/** ヘッダーに入れても割り込まれない、決まった形のメールアドレスか（設定の値を確かめる。利用者の入力には使わない） */
function contact_plain_address($value): bool
{
    return is_string($value) && strlen($value) <= EMAIL_MAX_CHARS
        && preg_match('/\A[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)+\z/', $value) === 1;
}

/** 設定が使える形か。使えなければ理由（運営者向け。画面には出さない） */
function contact_config_problem(?array $c): ?string
{
    if ($c === null) {
        return 'contact-config.php がありません';
    }
    if (!contact_plain_address($c['to'] ?? null)) {
        return 'to（届け先）の形が違います';
    }
    if (!contact_plain_address($c['from'] ?? null)) {
        return 'from（送信元）の形が違います';
    }
    if (!is_string($c['secret'] ?? null) || strlen($c['secret']) < 32) {
        return 'secret が 32 字より短いか、ありません';
    }
    if (!is_string($c['data_dir'] ?? null) || $c['data_dir'] === '') {
        return 'data_dir（迷惑防止の記録の置き場）がありません';
    }
    if (isset($c['origin']) && (!is_string($c['origin']) || preg_match('/\Ahttps:\/\/[a-z0-9.\-]+(:\d+)?\z/', $c['origin']) !== 1)) {
        return 'origin の形が違います';
    }
    if (isset($c['send']) && !is_callable($c['send'])) {
        return 'send が呼べません';
    }
    return null;
}

/** 同じサイトのページから送られたか（CSRF の対策） */
function contact_same_site(array $server, string $origin): bool
{
    $site = $server['HTTP_SEC_FETCH_SITE'] ?? null;
    $from = $server['HTTP_ORIGIN'] ?? null;
    // Origin が付いていれば、必ず同じサイトであること
    if (is_string($from) && $from !== $origin) {
        return false;
    }
    // 今のブラウザは Sec-Fetch-Site を付ける。付いていれば、それで決める
    if (is_string($site)) {
        return $site === 'same-origin';
    }
    // 付けない古いブラウザは、Origin で決める（お問い合わせのページは参照元の決まりを same-origin にしているので、同じサイトへの送信には Origin が付く）
    return is_string($from);
}

/** 接続元を、元に戻せない形にする。IPv6 は前の 64 ビットでまとめる（同じ回線の中で番号を変えて続けて送るのを防ぐ） */
function contact_client_key(array $server, string $secret): string
{
    $addr = is_string($server['REMOTE_ADDR'] ?? null) ? $server['REMOTE_ADDR'] : '';
    $packed = @inet_pton($addr);
    if ($packed !== false && strlen($packed) === 16) {
        $addr = bin2hex(substr($packed, 0, 8));
    }
    return substr(hash_hmac('sha256', $addr, $secret), 0, 32);
}

/**
 * 続けて送っていないかを確かめ、送ってよければ記録する。
 * 戻り値：null（送ってよい）・'client'（同じ接続元から続けて）・'daily'（サイト全体で多すぎる）・'storage'（記録を読み書きできない）
 */
function contact_rate(string $dir, string $key, int $now): ?string
{
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        return 'storage';
    }
    $fp = @fopen($dir . '/rate.json', 'c+');
    if ($fp === false) {
        return 'storage';
    }
    try {
        if (!flock($fp, LOCK_EX)) {
            return 'storage';
        }
        $raw = stream_get_contents($fp);
        $data = json_decode($raw === false || $raw === '' ? '[]' : $raw, true);
        $entries = [];
        foreach (is_array($data) ? $data : [] as $e) {
            // 24 時間より古い記録は、ここで消す
            if (is_array($e) && count($e) === 2 && is_string($e[0]) && is_int($e[1]) && $e[1] > $now - KEEP_SECONDS && $e[1] <= $now + 60) {
                $entries[] = $e;
            }
        }
        $result = null;
        if (count($entries) >= DAILY_MAX) {
            $result = 'daily';
        } else {
            foreach (LIMITS as [$seconds, $max]) {
                $n = 0;
                foreach ($entries as [$k, $t]) {
                    if ($k === $key && $t > $now - $seconds) {
                        $n++;
                    }
                }
                if ($n >= $max) {
                    $result = 'client';
                    break;
                }
            }
        }
        if ($result === null) {
            $entries[] = [$key, $now];
        }
        $json = json_encode($entries);
        if ($json === false || !ftruncate($fp, 0) || !rewind($fp) || fwrite($fp, $json) === false || !fflush($fp)) {
            return 'storage';
        }
        return $result;
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

/** 本文の字を整える：改行をそろえ、制御の字と、字の向きを変える見えない字を除く。UTF-8 でなければ null */
function contact_clean_text($value): ?string
{
    if (!is_string($value) || !mb_check_encoding($value, 'UTF-8')) {
        return null;
    }
    $t = str_replace(["\r\n", "\r"], "\n", $value);
    $t = preg_replace('/[\x{0000}-\x{0008}\x{000B}\x{000C}\x{000E}-\x{001F}\x{007F}\x{202A}-\x{202E}\x{2066}-\x{2069}]/u', '', $t);
    return $t === null ? null : trim($t);
}

/** 運営者へのメールを送る（設定の send があれば、そちらを使う。手元の確かめ用） */
function contact_deliver(array $config, string $subject, string $body): bool
{
    if (isset($config['send'])) {
        return (bool) ($config['send'])($config['to'], $subject, $body, $config['from']);
    }
    mb_language('uni');
    mb_internal_encoding('UTF-8');
    // 宛先・件名・送信元は、設定と決まった字だけ。-f で封筒の送信元も自分のドメインにする（届きやすさのため。docs/contact.md）
    return mb_send_mail($config['to'], $subject, $body, 'From: ' . $config['from'], '-f' . $config['from']);
}

/**
 * 1 回の送信を扱う。戻り値：['status' => HTTP の状態, 'page' => 'done'|'error', 'message' => 画面に出す一言, 'headers' => 足すヘッダー]
 */
function contact_handle(array $server, array $post, ?array $config, int $now): array
{
    $error = function (int $status, string $message, array $headers = []): array {
        return ['status' => $status, 'page' => 'error', 'message' => $message, 'headers' => $headers];
    };
    $retry = '時間をおいて、もう一度お試しください。';

    if (($server['REQUEST_METHOD'] ?? '') !== 'POST') {
        return $error(405, 'このページは、お問い合わせのページのフォームから送ったときに使います。', ['Allow: POST']);
    }
    if ((int) ($server['CONTENT_LENGTH'] ?? 0) > POST_MAX_BYTES) {
        return $error(413, '送った中身が大きすぎます。本文を短くしてください。');
    }
    if (contact_config_problem($config) !== null) {
        return $error(503, 'いまは、お問い合わせを受け付けられません。' . $retry);
    }
    if (!contact_same_site($server, $config['origin'] ?? DEFAULT_ORIGIN)) {
        return $error(403, 'このサイトのお問い合わせのページから送ってください。');
    }

    $trap = $post['website'] ?? '';
    $isBot = !is_string($trap) || $trap !== '';

    $kind = $post['kind'] ?? null;
    if (!$isBot && (!is_string($kind) || !array_key_exists($kind, KINDS))) {
        return $error(400, '種類を選んでください。');
    }
    $body = contact_clean_text($post['body'] ?? null);
    if (!$isBot && ($body === null || $body === '')) {
        return $error(400, '本文を書いてください。');
    }
    if (!$isBot && mb_strlen($body, 'UTF-8') > BODY_MAX_CHARS) {
        return $error(400, '本文は ' . BODY_MAX_CHARS . ' 字までにしてください（いまは ' . mb_strlen($body, 'UTF-8') . ' 字です）。');
    }
    $email = contact_clean_text($post['email'] ?? '');
    if (!$isBot && $email !== '' && ($email === null || strlen($email) > EMAIL_MAX_CHARS || filter_var($email, FILTER_VALIDATE_EMAIL) === false)) {
        return $error(400, 'メールアドレスの形が正しくありません。返事が要らないときは、空のままにしてください。');
    }
    if (!$isBot && $kind === 'security' && $email === '') {
        return $error(400, 'セキュリティの弱点のときは、こちらから連絡するため、メールアドレスを書いてください。');
    }

    // 続けて送っていないか（ボットの送信も数える）。記録を読み書きできないときは、受け付けない
    $rate = contact_rate($config['data_dir'], contact_client_key($server, $config['secret']), $now);
    if ($rate === 'client') {
        return $error(429, '続けて送ることはできません。しばらく時間をおいてから、もう一度送ってください。', ['Retry-After: ' . LIMITS[0][0]]);
    }
    if ($rate === 'daily') {
        return $error(429, 'いまは、お問い合わせが多いため、受け付けを止めています。明日以降に、もう一度送ってください。', ['Retry-After: 3600']);
    }
    if ($rate !== null) {
        return $error(503, 'いまは、お問い合わせを受け付けられません。' . $retry);
    }

    // 人には見えない欄が埋まっていた：送ったふりをする（ボットに、見分け方を教えない）
    if ($isBot) {
        return ['status' => 200, 'page' => 'done', 'message' => '', 'headers' => []];
    }

    $label = KINDS[$kind];
    $time = (new DateTimeImmutable('@' . $now))->setTimezone(new DateTimeZone('Asia/Tokyo'))->format('Y-m-d H:i:s') . '（日本の時刻）';
    $subject = '[お守りPDF] お問い合わせ（' . $label . '）';
    $text = implode("\n", [
        'お守りPDF のお問い合わせのフォームから届きました。',
        '',
        '種類：' . $label,
        '返事の宛先：' . ($email === '' ? '（書かれていません。返事は要らない）' : $email),
        '受け付けた時刻：' . $time,
        '',
        '---- 本文 ----',
        $body,
        '---- ここまで ----',
        '',
        'このメールは、対応が済んだら消してください。長くても、届いてから 90 日で消します（プライバシーのページの約束）。',
    ]);
    if (!contact_deliver($config, $subject, $text)) {
        return $error(503, 'メールを送れませんでした。' . $retry);
    }
    return ['status' => 200, 'page' => 'done', 'message' => '', 'headers' => []];
}

/** 結果のページを返す */
function contact_respond(array $result, array $pages, array $headers): void
{
    http_response_code($result['status']);
    foreach ($headers as $name => $value) {
        header($name . ': ' . $value);
    }
    header('Content-Type: text/html; charset=UTF-8');
    header('Cache-Control: no-store');
    foreach ($result['headers'] as $line) {
        header($line);
    }
    $html = $pages[$result['page']] ?? null;
    $message = htmlspecialchars($result['message'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
    echo $html === null ? $message : str_replace(MESSAGE_MARK, $message, $html);
}

// 手元の確かめ（tests/contact-php.test.ts）は、この定数を決めてから読み込み、contact_handle を直接呼ぶ
if (!defined('OMAMORI_CONTACT_TEST')) {
    contact_respond(contact_handle($_SERVER, $_POST, contact_load_config(), time()), $PAGES, $HEADERS);
}
