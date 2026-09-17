<?php
$data = file_get_contents('php://input');
if ($data) {
    file_put_contents('../overrides.json', $data);
    echo json_encode(["success" => true]);
} else {
    http_response_code(400);
    echo json_encode(["error" => "Keine Daten empfangen"]);
}
?>
