<?php
// Minimal stand-ins for the EspoCRM classes the license server client uses,
// so it can be tested against a real license server without EspoCRM.

namespace Espo\Core\Utils {
    class Config
    {
        public function __construct(private array $data = []) {}

        public function get(string $name, $default = null)
        {
            return $this->data[$name] ?? $default;
        }
    }
}

namespace Espo\Core\Exceptions {
    class BadRequest extends \Exception {}
    class Conflict extends \Exception {}
    class Error extends \Exception {}
    class Forbidden extends \Exception {}
    class NotFound extends \Exception {}
}

namespace {
    spl_autoload_register(function (string $class) {
        $prefix = 'Espo\\Modules\\LicenseManager\\';

        if (str_starts_with($class, $prefix)) {
            $file = __DIR__ . '/../../espocrm-extension/files/custom/Espo/Modules/LicenseManager/' .
                str_replace('\\', '/', substr($class, strlen($prefix))) . '.php';

            if (is_file($file)) {
                require $file;
            }
        }
    });
}
