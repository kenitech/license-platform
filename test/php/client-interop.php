<?php
// Exercises ServerClient against a running license server.
// env: LMP_URL, LMP_SECRET, LMP_CA (test certificate)
require __DIR__ . '/bootstrap.php';

use Espo\Core\Utils\Config;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerClient;
use Espo\Modules\LicenseManager\Tools\LicenseServer\ServerException;

$results = [];
$make = function (string $secret) {
    $client = new ServerClient(new Config([
        'licenseManagerServerUrl' => getenv('LMP_URL'),
        'licenseManagerClientId' => 'espocrm',
        'licenseManagerClientSecret' => $secret,
    ]));
    // Same as production, but trusting the test certificate.
    $client->setTransport(function ($method, $url, $headers, $body) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $headers, CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CAINFO => getenv('LMP_CA'), CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        if ($method !== 'GET') curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        $out = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return [$status, (string) $out];
    });
    return $client;
};

$client = $make(getenv('LMP_SECRET'));

$results['status'] = $client->get('/v1/admin/status', ['fresh' => '1'])['auditChain'];
$results['app'] = $client->put('/v1/admin/applications/php-app', [
    'name' => 'PHP App', 'supportedOs' => ['Windows'], 'offlinePolicy' => 'perpetual', 'status' => 'active',
    'actor' => ['id' => 'u1', 'name' => 'Ünïcode Admin'],
])['productId'];
$results['plan'] = $client->put('/v1/admin/applications/php-app/plans/basic', [
    'name' => 'Basic', 'type' => 'lifetime', 'maxDevices' => 1, 'priceCents' => 1000, 'entitlements' => ['basic'],
])['code'];
$issued = $client->post('/v1/admin/licenses/issue', [
    'productId' => 'php-app', 'planCode' => 'basic', 'quantity' => 2,
    'customer' => ['id' => 'acc1', 'name' => 'Customer'], 'order' => ['ref' => 'ORD-PHP-1', 'itemId' => 'item1'],
]);
$results['issued'] = count($issued['issued']);
$results['keyFormat'] = (bool) preg_match('/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/', $issued['issued'][0]['key']);
$changes = $client->get('/v1/admin/changes', ['since' => 0, 'auditSince' => 0, 'limit' => 500]);
$results['changes'] = count($changes['licenses']);
$id = $issued['issued'][0]['id'];
$results['suspend'] = $client->post('/v1/admin/licenses/' . ServerClient::encodeSegment($id) . '/suspend', ['reason' => 'test reason'])['license']['status'];
$replay1 = $client->post('/v1/admin/licenses/' . $id . '/replace-key', ['reason' => 'lost key'], 'replace-key-abc12345');
$replay2 = $client->post('/v1/admin/licenses/' . $id . '/replace-key', ['reason' => 'lost key'], 'replace-key-abc12345');
$results['replayKeyHidden'] = isset($replay1['key']) && !isset($replay2['key']) && !empty($replay2['replayed']);

try {
    $client->post('/v1/admin/licenses/issue', ['productId' => 'php-app', 'planCode' => 'basic', 'quantity' => 1]);
    $results['grantReason'] = 'not refused';
} catch (ServerException $e) {
    $results['grantReason'] = $e->getErrorCode();
}

try {
    $make('wrong-secret-wrong-secret')->get('/v1/admin/status');
    $results['badSecret'] = 'accepted';
} catch (ServerException $e) {
    $results['badSecret'] = $e->getMessage();
}

$unconfigured = new ServerClient(new Config([]));
try {
    $unconfigured->get('/v1/admin/status');
} catch (ServerException $e) {
    $results['notConfigured'] = $e->getMessage();
}

$down = new ServerClient(new Config([
    'licenseManagerServerUrl' => 'https://127.0.0.1:1', 'licenseManagerClientId' => 'x', 'licenseManagerClientSecret' => 'y',
    'licenseManagerTimeout' => 3,
]));
try {
    $down->get('/v1/admin/status');
} catch (ServerException $e) {
    $results['down'] = $e->isUnavailable() ? 'unavailable' : $e->getErrorCode();
}

echo json_encode($results), "\n";
