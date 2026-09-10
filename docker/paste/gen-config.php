<?php
/* Write PASTE's config.php for the bed from the environment (run by the
 * entrypoint; FILEHOST_PEM is derived there from the ircd's key). */
$tpl = file_get_contents('/var/www/html/docs/config.example.php');
$env = fn(string $k, string $d = '') => getenv($k) !== false ? (string)getenv($k) : $d;
$set = [
    '$dbhost = '     => '$dbhost = ' . var_export($env('DB_HOST', 'paste-db'), true) . ';',
    '$dbuser = '     => '$dbuser = ' . var_export($env('DB_USER', 'paste'), true) . ';',
    '$dbpassword = ' => '$dbpassword = ' . var_export($env('DB_PASSWORD', 'paste'), true) . ';',
    '$dbname = '     => '$dbname = ' . var_export($env('DB_NAME', 'paste'), true) . ';',
    '$mod_rewrite = ' => '$mod_rewrite = "1";',
    "define('FILEHOST_ENABLED'," => "define('FILEHOST_ENABLED', true);",
    "define('FILEHOST_URL',"     => "define('FILEHOST_URL', " . var_export($env('FILEHOST_URL', 'http://localhost:8089/filehost'), true) . ');',
    "define('FILEHOST_ISSUER',"  => "define('FILEHOST_ISSUER', " . var_export($env('FILEHOST_ISSUER', 'Network'), true) . ');',
    "define('FILEHOST_PUBKEY',"  => "define('FILEHOST_PUBKEY', " . var_export($env('FILEHOST_PEM'), true) . ');',
    "define('FILEHOST_DIR',"     => "define('FILEHOST_DIR', '/var/filehost');",
    "define('FILEHOST_MAX_BYTES'," => "define('FILEHOST_MAX_BYTES', " . (int)$env('FILEHOST_MAX_BYTES', '2097152') . ');',
    "define('FILEHOST_PER_HOUR'," => "define('FILEHOST_PER_HOUR', " . (int)$env('FILEHOST_PER_HOUR', '200') . ');',
];
$out = [];
foreach (explode("\n", $tpl) as $line) {
    foreach ($set as $prefix => $repl) {
        if (str_starts_with($line, $prefix)) { $line = $repl; break; }
    }
    $out[] = $line;
}
file_put_contents('/var/www/html/config.php', implode("\n", $out));
echo "config.php written; FILEHOST_PUBKEY " . ($env('FILEHOST_PEM') === '' ? 'EMPTY' : 'set') . "\n";
