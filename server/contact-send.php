<?php
// SPDX-License-Identifier: AGPL-3.0-only
//
// お守りPDF のお問い合わせ（フォームを返す・受け付ける）。手順と決まりは docs/contact.md。
// npm run build のとき、site.ts がこのファイルにページの HTML を差し込み、dist/contact-send.php として出す。
// dist/contact-send.php を直接書き換えない。
//
// 決まり（2026-11-05 本人が決定）：
// - GET：フォームのページを返す（本番では .htaccess が /contact をここへ回す）。開いた時刻に署名した印を、隠れた欄に入れる
// - POST：確かめてから、運営者へのメール 1 通にする。ほかの会社のサービス（フォームの代行・reCAPTCHA・解析）には送らない
// - メールのヘッダー（宛先・件名・送信元）に、入力を入れない。件名は決まった字と、決まった 4 つの種類の名前だけ
// - 同じサイトのページから送られたときだけ受け付ける（CSRF の対策。Sec-Fetch-Site か Origin で見る。Cookie は使わない）
// - 人には見えない欄が埋まっていたら、送ったふりをして、メールは出さない（ボットの対策）
// - ページを開いてから TOKEN_MIN_SECONDS 秒より早く送られたものは、送らない（ボットの対策）
// - 同じ接続元から続けて送れない。同じ本文を続けて送れない。どちらも鍵つきのハッシュ（鍵がなければ元に戻せない形）にして、最長 24 時間だけ残す
// - 1 日の上限は、実際にメールを送れた分だけを数える。「セキュリティの弱点」は別の枠。上限に達したら、運営者に 1 日 1 通だけ知らせる
// - 入力をページに戻すときは、必ずエスケープする。エラーのときに、設定やファイルの場所を出さない
// - CSP などのヘッダーは、.htaccess（htaccess.ts）だけが付ける（ここでも付けると、同じヘッダーが 2 つになるおそれがあるため）
// - 届け先などの本物の設定は、public_html の外の contact-config.php に置く（リポジトリには入れない。ひな形は server/contact-config.sample.php）
// - 動かすには PHP 8.0 以上と mbstring が要る

declare(strict_types=1);

// 警告やエラーの中身（ファイルの場所など）を、画面に出さない。サーバーの記録にだけ残す。PHP の版も名乗らない
ini_set('display_errors', '0');
if (!headers_sent()) {
    header_remove('X-Powered-By');
}

/** 種類。値（左）はフォームの value、名前（右）はメールの件名と本文に入れる。件名に入るのはこの決まった名前だけ */
const KINDS = ['question' => '質問', 'bug' => '不具合', 'security' => 'セキュリティの弱点', 'other' => 'その他'];
const BODY_MIN_CHARS = 10;
const BODY_MAX_CHARS = 4000;
const EMAIL_MAX_CHARS = 254;
/** 本文の中の URL の数の上限（宣伝の投稿を防ぐ） */
const URL_MAX = 2;
const POST_MAX_BYTES = 65536;
/** 人には見えない欄の名前（ボットだけが埋める）。自動入力が埋めないよう、意味のない名前にする（pages.ts の CONTACT_TRAP_FIELD と同じ） */
const TRAP_FIELD = 'hp_x7q';
/** ページを開いてから送るまでに、少なくとも何秒（これより早いものはボットとみなす） */
const TOKEN_MIN_SECONDS = 4;
/** ページを開いてから送るまで、長くても何秒（古いページの印は使わせない） */
const TOKEN_MAX_SECONDS = 7200;
/** 同じ接続元から：[何秒の間に, 何回まで]。送ろうとした回数（ボットの送信・送れなかった送信も含む）で数える。
 * 24 時間に 3 回までにして、1 つの接続元だけで 1 日の上限（ふつう・セキュリティの弱点のどちらの枠も）を使い切れないようにする（記録は 24 時間残すので数えられる） */
const LIMITS = [[60, 1], [3600, 5], [86400, 3]];
/** 24 時間に、実際にメールを送る数の上限（届け先のメールの箱をあふれさせないため）。種類ごとの枠：'g' はふつう、's' はセキュリティの弱点 */
const DAILY_MAX = ['g' => 50, 's' => 20];
/** 迷惑防止の記録を残す長さ（秒）。同じ本文を止める長さ・1 日の上限の長さも同じ */
const KEEP_SECONDS = 86400;
/** 迷惑防止の記録の、種類ごとの数の上限（記録のファイルが大きくなりすぎないため。古いものから捨てる） */
const STORE_MAX = 1000;
const DEFAULT_ORIGIN = 'https://omamoripdf.com';
const MESSAGE_MARK = '<!--CONTACT_MESSAGE-->';
const ERRORS_MARK = '<!--CONTACT_ERRORS-->';
const ERRORS_TOP_MARK = '<!--CONTACT_ERRORS_TOP-->';
const TOKEN_FIELD = 'name="t" value=""';
const RETRY = '時間をおいて、もう一度お試しください。';

/** ページ（'form'・'done'・'error'）。ビルドで差し込む */
$PAGES = []; // @@PAGES@@

/** 届け先などの本物の設定を読む。public_html（このファイルの置き場）の 1 つ上の contact-config.php。場所に入力は使わない */
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

/** ページを開いた時刻の印（時刻と、secret で作った署名）。秘密がなければ空 */
function contact_token(?array $config, int $now): string
{
    if (!is_string($config['secret'] ?? null) || strlen($config['secret']) < 32) {
        return '';
    }
    return $now . '.' . substr(hash_hmac('sha256', 'contact-form|' . $now, $config['secret']), 0, 32);
}

/** 印を確かめる。戻り値：null（よい）・'missing'（ない・偽物）・'fast'（早すぎる）・'old'（古すぎる） */
function contact_check_token($token, string $secret, int $now): ?string
{
    if (!is_string($token) || preg_match('/\A(\d{1,12})\.([0-9a-f]{32})\z/', $token, $m) !== 1) {
        return 'missing';
    }
    $issued = (int) $m[1];
    $want = substr(hash_hmac('sha256', 'contact-form|' . $issued, $secret), 0, 32);
    if (!hash_equals($want, $m[2])) {
        return 'missing';
    }
    if ($now - $issued < TOKEN_MIN_SECONDS) {
        return 'fast';
    }
    if ($now - $issued > TOKEN_MAX_SECONDS) {
        return 'old';
    }
    return null;
}

/**
 * 接続元を、鍵がなければ元に戻せない形にする（鍵が漏れると、IPv4 は総当たりで戻せる）。
 * IPv6 は前の 64 ビットでまとめる（同じ回線の中で番号を変えて続けて送るのを防ぐ）。
 * IPv4 が IPv6 の形（::ffff:192.0.2.1）で来たときは、IPv4 として扱う（まとめると、全員が同じ鍵になるため）
 */
function contact_client_key(array $server, string $secret): string
{
    $addr = is_string($server['REMOTE_ADDR'] ?? null) ? $server['REMOTE_ADDR'] : '';
    $packed = @inet_pton($addr);
    if ($packed !== false && strlen($packed) === 16) {
        if (substr($packed, 0, 12) === str_repeat("\0", 10) . "\xff\xff") {
            $addr = inet_ntop(substr($packed, 12)) ?: $addr;
        } else {
            $addr = bin2hex(substr($packed, 0, 8));
        }
    }
    return substr(hash_hmac('sha256', 'client|' . $addr, $secret), 0, 32);
}

/** 本文を、鍵がなければ元に戻せない形にする（同じ本文を続けて送るのを止めるため）。空白の違いと、英字の大きさの違いは同じとみなす */
function contact_body_key(string $body, string $secret): string
{
    $flat = mb_strtolower(preg_replace('/\s+/u', '', $body) ?? $body, 'UTF-8');
    return substr(hash_hmac('sha256', 'body|' . $flat, $secret), 0, 32);
}

/** 記録の 1 種類を読む：24 時間より古いもの・形の違うものを除き、数の上限で古いものから捨てる */
function contact_store_list($list, int $now, int $keyLength = 32): array
{
    $out = [];
    foreach (is_array($list) ? $list : [] as $e) {
        if (is_array($e) && count($e) === 2 && is_string($e[0]) && strlen($e[0]) === $keyLength && is_int($e[1]) && $e[1] > $now - KEEP_SECONDS && $e[1] <= $now + 60) {
            $out[] = [$e[0], $e[1]];
        }
    }
    return array_slice($out, -STORE_MAX);
}

/**
 * 迷惑防止の記録を、ほかの送信と重ならないように（ロックして）読み、$fn で確かめ・送り・書き足してから、書き戻す。
 * 記録：'c' 接続元（送ろうとした時刻）・'b' 送れた本文・'s' 送れた数（種類の枠と時刻）・'n' 上限の知らせを出した時刻。
 * 記録を読み書きできないときは null（受け付けない側に倒す）
 */
function contact_with_store(string $dir, int $now, callable $fn): ?array
{
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) {
        return null;
    }
    $fp = @fopen($dir . '/rate.json', 'c+');
    if ($fp === false) {
        return null;
    }
    try {
        if (!flock($fp, LOCK_EX)) {
            return null;
        }
        $raw = stream_get_contents($fp);
        $data = json_decode($raw === false || $raw === '' ? '{}' : $raw, true);
        $data = is_array($data) ? $data : [];
        $store = [
            'c' => contact_store_list($data['c'] ?? [], $now),
            'b' => contact_store_list($data['b'] ?? [], $now),
            's' => contact_store_list($data['s'] ?? [], $now, 1),
            'n' => contact_store_list($data['n'] ?? [], $now, 1),
        ];
        $result = $fn($store);
        foreach ($store as $k => $list) {
            $store[$k] = array_slice($list, -STORE_MAX);
        }
        $json = json_encode($store);
        if ($json === false || !ftruncate($fp, 0) || !rewind($fp) || fwrite($fp, $json) === false || !fflush($fp)) {
            return null;
        }
        return $result;
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

/** 同じ接続元から、続けて送ろうとしていないか。送れるなら 0、送れないなら、また送れるようになるまでの秒数 */
function contact_client_busy(array $store, string $client, int $now): int
{
    $wait = 0;
    foreach (LIMITS as [$seconds, $max]) {
        $times = [];
        foreach ($store['c'] as [$k, $t]) {
            if ($k === $client && $t > $now - $seconds) {
                $times[] = $t;
            }
        }
        if (count($times) >= $max) {
            sort($times);
            // 数が上限より 1 つ少なくなる（古いほうから max 個目までが外に出る）まで
            $wait = max($wait, $times[count($times) - $max] + $seconds - $now, 1);
        }
    }
    return $wait;
}

/** 字を整える：改行をそろえ、制御の字と、見えない字・字の向きを変える字を除き、前後の空白を除く。字でない・UTF-8 でなければ null */
function contact_clean_text($value): ?string
{
    if (!is_string($value) || !mb_check_encoding($value, 'UTF-8')) {
        return null;
    }
    $t = str_replace(["\r\n", "\r"], "\n", $value);
    $t = preg_replace('/[\x{0000}-\x{0008}\x{000B}\x{000C}\x{000E}-\x{001F}\x{007F}-\x{009F}\x{061C}\x{200B}-\x{200F}\x{2028}-\x{202E}\x{2060}-\x{2069}\x{FEFF}]/u', '', $t);
    return $t === null ? null : trim($t);
}

/** 本文の中の URL の数（全角の英字も半角にして数える） */
function contact_count_urls(string $body): int
{
    $flat = mb_convert_kana($body, 'as', 'UTF-8');
    return preg_match_all('/(?:https?|ftp):\/\/|www\.[a-z0-9\-]/iu', $flat);
}

/**
 * 欄ごとの入力の誤り（鍵は欄の名前）。画面の決まり（pages.ts の CONTACT_KINDS・CONTACT_BODY_MIN など）と同じ規則
 * @return array<string, string>
 */
function contact_validate($kind, ?string $body, ?string $email): array
{
    $errors = [];
    if (!is_string($kind) || !array_key_exists($kind, KINDS)) {
        $errors['kind'] = '種類：4 つの中から 1 つ選んでください。';
    }
    if ($body === null) {
        $errors['body'] = '本文：読めない字が入っています。書き直してください。';
    } else {
        $len = mb_strlen($body, 'UTF-8');
        $urls = contact_count_urls($body);
        if ($len < BODY_MIN_CHARS) {
            $errors['body'] = '本文：' . BODY_MIN_CHARS . ' 字以上書いてください（いまは ' . $len . ' 字です）。';
        } elseif ($len > BODY_MAX_CHARS) {
            $errors['body'] = '本文：' . BODY_MAX_CHARS . ' 字までにしてください（いまは ' . $len . ' 字です）。';
        } elseif ($urls > URL_MAX) {
            $errors['body'] = '本文：URL は ' . URL_MAX . ' つまでにしてください（いまは ' . $urls . ' つです）。';
        }
    }
    if ($email === null || ($email !== '' && (strlen($email) > EMAIL_MAX_CHARS || filter_var($email, FILTER_VALIDATE_EMAIL) === false))) {
        $errors['email'] = 'メールアドレス：形が正しくありません（「@」の前後に字がある、ふつうのメールアドレスの形）。返事が要らないときは、空のままにしてください。';
    } elseif ($kind === 'security' && $email === '') {
        $errors['email'] = 'メールアドレス：セキュリティの弱点のときは、こちらから連絡するため、書いてください。';
    }
    return $errors;
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
 * 1 回の要求を扱う。戻り値：
 * ['status' => HTTP の状態, 'page' => 'form'|'done'|'error', 'messages' => 画面に出す理由（欄の名前か数字の鍵）,
 *  'headers' => 足すヘッダー, 'values' => フォームに戻す入力, 'token' => フォームに入れる印]
 */
function contact_handle(array $server, array $post, ?array $config, int $now, array $files = []): array
{
    $result = function (int $status, string $page, array $messages = [], array $headers = [], array $values = []) use ($config, $now): array {
        return ['status' => $status, 'page' => $page, 'messages' => $messages, 'headers' => $headers, 'values' => $values, 'token' => $page === 'form' ? contact_token($config, $now) : ''];
    };
    $unavailable = fn () => $result(503, 'error', ['いまは、お問い合わせを受け付けられません。' . RETRY]);
    $method = $server['REQUEST_METHOD'] ?? '';

    // 開いたとき：フォームを返す（開いた時刻の印つき）
    if ($method === 'GET' || $method === 'HEAD') {
        return $result(200, 'form');
    }
    if ($method !== 'POST') {
        return $result(405, 'error', ['このページは、開くか、フォームから送るときだけ使います。'], ['Allow: GET, HEAD, POST']);
    }
    if ((int) ($server['CONTENT_LENGTH'] ?? 0) > POST_MAX_BYTES) {
        return $result(413, 'error', ['送った中身が大きすぎます。本文を短くしてください。']);
    }
    // フォームのふつうの送り方（application/x-www-form-urlencoded）だけ。ファイルは受け取らない
    $type = strtolower(trim(explode(';', (string) ($server['CONTENT_TYPE'] ?? ''))[0]));
    if ($type !== 'application/x-www-form-urlencoded' || $files !== []) {
        return $result(400, 'error', ['このサイトのお問い合わせのページから送ってください。ファイルは送れません。']);
    }
    if (contact_config_problem($config) !== null) {
        return $unavailable();
    }
    if (!contact_same_site($server, $config['origin'] ?? DEFAULT_ORIGIN)) {
        return $result(403, 'error', ['このサイトのお問い合わせのページから送ってください。']);
    }

    $trap = $post[TRAP_FIELD] ?? '';
    $isBot = !is_string($trap) || $trap !== '';
    $kind = $post['kind'] ?? null;
    $body = contact_clean_text($post['body'] ?? null);
    $email = contact_clean_text($post['email'] ?? '');
    // フォームに戻す入力（決まった種類・字だけ。ページに入れるときにエスケープする）
    $values = [
        'kind' => is_string($kind) && array_key_exists($kind, KINDS) ? $kind : '',
        'body' => $body ?? '',
        'email' => $email ?? '',
    ];
    $client = contact_client_key($server, $config['secret']);

    // 人には見えない欄が埋まっていた：送ったふりをする（ボットに、見分け方を教えない）。
    // その接続元の続けての数には入れるが、1 日の上限には数えない（ボットに、フォーム全体を止めさせないため）
    if ($isBot) {
        $done = contact_with_store($config['data_dir'], $now, function (array &$store) use ($client, $now): array {
            if (contact_client_busy($store, $client, $now) === 0) {
                $store['c'][] = [$client, $now];
            }
            return ['bot'];
        });
        return $done === null ? $unavailable() : $result(200, 'done');
    }

    // ページを開いてから送るまでの時間
    $token = contact_check_token($post['t'] ?? null, $config['secret'], $now);
    $again = '書いた中身を確かめてから、もう一度「送る」を押してください。';
    if ($token === 'fast') {
        return $result(400, 'form', ['form' => '送るのが早すぎました。' . $again], [], $values);
    }
    if ($token === 'old') {
        return $result(400, 'form', ['form' => 'ページを開いてから時間がたちました。' . $again], [], $values);
    }
    if ($token !== null) {
        return $result(400, 'form', ['form' => 'このページから送られたことを確かめられませんでした。' . $again], [], $values);
    }

    $errors = contact_validate($kind, $body, $email);
    if ($errors !== []) {
        return $result(400, 'form', $errors, [], $values);
    }

    $label = KINDS[$kind];
    $time = (new DateTimeImmutable('@' . $now))->setTimezone(new DateTimeZone('Asia/Tokyo'))->format('Y-m-d H:i:s') . '（日本の時刻）';
    $subject = '[お守りPDF] お問い合わせ（' . $label . '）';
    // 本文の区切りの印。毎回でたらめにして、本文の中に偽の区切りを書かれても見分けられるようにする
    $mark = bin2hex(random_bytes(4));
    $text = implode("\n", [
        'お守りPDF のお問い合わせのフォームから届きました。',
        '',
        '種類：' . $label,
        '返事の宛先：' . ($email === '' ? '（書かれていません。返事は要らない）' : $email),
        '受け付けた時刻：' . $time,
        '',
        '本文は、次の 2 つの区切りの間です。区切りの印（' . $mark . '）が違う行は、本文の一部です。',
        '---- 本文（印 ' . $mark . '）----',
        $body,
        '---- 本文ここまで（印 ' . $mark . '）----',
        '',
        'このメールは、対応が済んだら消してください。長くても、届いてから 90 日で消します（プライバシーのページの約束）。',
    ]);
    $bodyKey = contact_body_key($body, $config['secret']);
    $slot = $kind === 'security' ? 's' : 'g';

    // 記録をロックしたまま、確かめる → 送る → 書き足す（ほかの送信と重なって、上限を超えないように）
    $outcome = contact_with_store($config['data_dir'], $now, function (array &$store) use ($client, $bodyKey, $slot, $now, $config, $subject, $text): array {
        $wait = contact_client_busy($store, $client, $now);
        if ($wait > 0) {
            return ['client', $wait];
        }
        // 送ろうとした回数として数える（送れなかったときも、その接続元からの繰り返しは止める）
        $store['c'][] = [$client, $now];
        foreach ($store['b'] as [$k]) {
            if ($k === $bodyKey) {
                return ['duplicate'];
            }
        }
        $sent = array_values(array_filter($store['s'], fn ($e) => $e[0] === $slot));
        if (count($sent) >= DAILY_MAX[$slot]) {
            // 上限に達した：運営者に、24 時間に 1 通だけ知らせる（中身は入れない）
            if ($store['n'] === []) {
                $store['n'][] = ['n', $now];
                contact_deliver($config, '[お守りPDF] お問い合わせの 1 日の上限に達しました', "お問い合わせのフォームが、24 時間の上限（" . ($slot === 's' ? 'セキュリティの弱点' : 'ふつう') . "）に達し、受け付けを止めています。\n迷惑な送信が続いていないか、サーバーのアクセスログで確かめてください。\nこの知らせは、24 時間に 1 通だけ送ります。");
            }
            // 最も古い送信が 24 時間の外に出るまでの秒数
            return ['daily', max(60, $sent[0][1] + KEEP_SECONDS - $now)];
        }
        if (!contact_deliver($config, $subject, $text)) {
            return ['failed'];
        }
        // 1 日の上限と、同じ本文は、実際に送れた分だけを数える
        $store['s'][] = [$slot, $now];
        $store['b'][] = [$bodyKey, $now];
        return ['sent'];
    });

    if ($outcome === null) {
        return $unavailable();
    }
    switch ($outcome[0]) {
        case 'client':
            return $result(429, 'error', ['続けて送ることはできません。しばらく時間をおいてから、もう一度送ってください。'], ['Retry-After: ' . $outcome[1]]);
        case 'duplicate':
            return $result(409, 'error', ['同じ本文は、すでに受け付けています。続けて送る必要はありません。']);
        case 'daily':
            return $result(429, 'error', ['いまは、お問い合わせが多いため、受け付けを止めています。明日以降に、もう一度送ってください。'], ['Retry-After: ' . $outcome[1]]);
        case 'failed':
            return $result(503, 'error', ['メールを送れませんでした。' . RETRY]);
    }
    return $result(200, 'done');
}

/** HTML に入れる字のエスケープ */
function contact_h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

/** フォームのページに、理由・入力・開いた時刻の印を入れる。入力はすべてエスケープしてから入れる */
function contact_fill_form(string $html, array $result): string
{
    $messages = $result['messages'];
    if ($messages !== []) {
        $items = '';
        foreach ($messages as $m) {
            $items .= '<li>' . contact_h($m) . '</li>';
        }
        $box = '<div class="site-form-warn site-form-errors" id="contact-errors"><p>送れませんでした。次の所を直してから、もう一度「送る」を押してください。</p><ul>' . $items . '</ul></div>';
        $html = str_replace(ERRORS_MARK, $box, $html);
        // ページの上にも一言（スクリプトなしでは、送ったあとのページは上から表示されるため）
        $top = '<p class="site-form-warn" role="alert"><a href="#contact-errors">送れませんでした。直す所を、下のフォームの上に書いています。</a></p>';
        $html = str_replace(ERRORS_TOP_MARK, $top, $html);
    }
    $html = str_replace(TOKEN_FIELD, 'name="t" value="' . contact_h($result['token']) . '"', $html);
    $v = $result['values'];
    if (($v['kind'] ?? '') !== '' && array_key_exists($v['kind'], KINDS)) {
        $html = str_replace('value="' . $v['kind'] . '" required />', 'value="' . $v['kind'] . '" required checked />', $html);
    }
    // 誤りのある欄に、読み上げにも分かる印（aria-invalid）を付ける
    foreach (['body' => '<textarea id="contact-body"', 'email' => '<input id="contact-email"'] as $field => $tag) {
        if (isset($messages[$field])) {
            $html = str_replace($tag, $tag . ' aria-invalid="true"', $html);
        }
    }
    if (($v['body'] ?? '') !== '') {
        // textarea の中身の最初の改行はブラウザが捨てるので、1 つ足してから入れる
        $html = preg_replace_callback('/(<textarea id="contact-body"[^>]*>)<\/textarea>/', fn ($m) => $m[1] . "\n" . contact_h($v['body']) . '</textarea>', $html, 1) ?? $html;
    }
    if (($v['email'] ?? '') !== '') {
        $html = str_replace('<input id="contact-email"', '<input id="contact-email" value="' . contact_h($v['email']) . '"', $html);
    }
    return $html;
}

/** 応答の中身を作る */
function contact_render(array $result, array $pages): string
{
    $html = $pages[$result['page']] ?? null;
    if ($html === null) {
        return contact_h(implode(' ', $result['messages']));
    }
    if ($result['page'] === 'form') {
        return contact_fill_form($html, $result);
    }
    $items = '';
    foreach ($result['messages'] as $m) {
        $items .= contact_h($m);
    }
    return str_replace(MESSAGE_MARK, $items, $html);
}

/** 応答を返す。CSP などは .htaccess が付ける（ここでは付けない） */
function contact_respond(array $result, array $pages, bool $head = false): void
{
    http_response_code($result['status']);
    header('Content-Type: text/html; charset=UTF-8');
    foreach ($result['headers'] as $line) {
        header($line);
    }
    if (!$head) {
        echo contact_render($result, $pages);
    }
}

// 手元の確かめ（tests/contact-php.test.ts）は、この定数を決めてから読み込み、contact_handle を直接呼ぶ
if (!defined('OMAMORI_CONTACT_TEST')) {
    try {
        $result = contact_handle($_SERVER, $_POST, contact_load_config(), time(), $_FILES);
    } catch (Throwable $e) {
        // 中身（設定やファイルの場所）は画面に出さず、サーバーの記録にだけ残す
        error_log('contact-send: ' . get_class($e));
        $result = ['status' => 503, 'page' => 'error', 'messages' => ['いまは、お問い合わせを受け付けられません。' . RETRY], 'headers' => [], 'values' => [], 'token' => ''];
    }
    contact_respond($result, $PAGES, ($_SERVER['REQUEST_METHOD'] ?? '') === 'HEAD');
}
