#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ============================================================
// Wemos D1 R1 - 논리 입력/출력 제어
//
// 물리적인 D12/D13/D14/D15, D8/D9/D10/D11을
// ControlChannel에서 직접 사용하지 않습니다.
//
// 입력 변수 : IS1 ~ IS4
// 출력 변수 : OS1 ~ OS4
//
// 예:
//   IS1 = true;   // 입력 1 ON
//   OS1 = true;   // 출력 1 ON
//
// 서버 명령도 D8, D9 등이 아니라 OS1, OS2 ... 를 사용합니다.
// ============================================================

const uint8_t CHANNEL_COUNT = 8;

// ------------------------------------------------------------
// 논리 입력 변수
// ------------------------------------------------------------
bool IS1 = false;
bool IS2 = false;
bool IS3 = false;
bool IS4 = false;
bool IS5 = false;
bool IS6 = false;
bool IS7 = false;
bool IS8 = false;

// ------------------------------------------------------------
// 논리 출력 변수
// ------------------------------------------------------------
bool OS1 = false;
bool OS2 = false;
bool OS3 = false;
bool OS4 = false;
bool OS5 = false;
bool OS6 = false;
bool OS7 = false;
bool OS8 = false;

// ------------------------------------------------------------
// 서버로 보내는 문자열
// IStr1 ~ IStr8 : Wemos -> Server
// ------------------------------------------------------------
String IStr1 = "";
String IStr2 = "";
String IStr3 = "";
String IStr4 = "";
String IStr5 = "";
String IStr6 = "";
String IStr7 = "";
String IStr8 = "";

// ------------------------------------------------------------
// 서버에서 받는 문자열
// OStr1 ~ OStr8 : Server -> Wemos
// ------------------------------------------------------------
String OStr1 = "";
String OStr2 = "";
String OStr3 = "";
String OStr4 = "";
String OStr5 = "";
String OStr6 = "";
String OStr7 = "";
String OStr8 = "";

// ------------------------------------------------------------
// 통신 설정
// ------------------------------------------------------------
const unsigned long WIFI_RETRY_MS = 5000;
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000;
const unsigned long WS_RECONNECT_MS = 5000;
const unsigned long WS_PING_INTERVAL_MS = 15000;
const unsigned long WS_PONG_TIMEOUT_MS = 3000;
const uint8_t WS_DISCONNECT_TIMEOUT_COUNT = 2;

// 사용자 환경에 맞게 수정
const char *WIFI_SSID = "YOUR_WIFI_SSID";
const char *WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";

const char *SERVER_HOST = "YOUR_CLOUDTYPE_HOST";
const uint16_t SERVER_PORT = 443;
const bool SERVER_USE_TLS = true;

// 장치 정보
const char *DEVICE_ID = "WEMOS-D1-002";
const char *DEVICE_TOKEN = "YOUR_DEVICE_TOKEN";

// 기본 논리 출력
const char *DEVICE_PIN_NAME = "OS1";

String WS_PATH;
WebSocketsClient webSocket;

// ============================================================
// ControlChannel
//
// 중요:
// inputState  -> IS1, IS2, IS3, IS4 자체를 참조
// outputState -> OS1, OS2, OS3, OS4 자체를 참조
//
// 따라서 아래 초기화가 정확하게 가능합니다.
//
// {IS1, OS1, "IS1", "OS1", false, false, false, 0, false, "WEMOS", ""}
// ============================================================
struct ControlChannel
{
    bool &inputState;
    bool &outputState;

    const char *inputName;
    const char *outputName;

    String &inputString;
    String &outputString;

    bool lastRawInput;
    bool debouncedInput;
    bool stateReportPending;
    unsigned long lastDebounceMs;

    String pendingStateSource;
    String lastProcessedCommandId;
};

// ============================================================
// 채널 객체
//
// 사용자가 요청한 형식을 그대로 사용합니다.
// ============================================================
ControlChannel channels[CHANNEL_COUNT] = {
    {IS1, OS1, "IS1", "OS1", IStr1, OStr1, false, false, false, 0, "WEMOS", ""},
    {IS2, OS2, "IS2", "OS2", IStr2, OStr2, false, false, false, 0, "WEMOS", ""},
    {IS3, OS3, "IS3", "OS3", IStr3, OStr3, false, false, false, 0, "WEMOS", ""},
    {IS4, OS4, "IS4", "OS4", IStr4, OStr4, false, false, false, 0, "WEMOS", ""},
    {IS5, OS5, "IS5", "OS5", IStr5, OStr5, false, false, false, 0, "WEMOS", ""},
    {IS6, OS6, "IS6", "OS6", IStr6, OStr6, false, false, false, 0, "WEMOS", ""},
    {IS7, OS7, "IS7", "OS7", IStr7, OStr7, false, false, false, 0, "WEMOS", ""},
    {IS8, OS8, "IS8", "OS8", IStr8, OStr8, false, false, false, 0, "WEMOS", ""}
};

// ------------------------------------------------------------
// WebSocket / Wi-Fi 상태
// ------------------------------------------------------------
bool wsConnected = false;
bool wsStarted = false;
bool wasWiFiConnected = false;
bool wifiAttemptPending = false;
unsigned long lastWiFiAttemptMs = 0;

// ------------------------------------------------------------
// 함수 선언
// ------------------------------------------------------------
bool connectWiFi();
void startWebSocket();
void handleWiFi();

void webSocketEvent(
    WStype_t type,
    uint8_t *payload,
    size_t length
);

void sendHello();
void sendChannelString(ControlChannel &channel);

void sendStateReport(
    ControlChannel &channel,
    const String &source
);

void sendAck(
    ControlChannel &channel,
    const String &commandId,
    const String &stateValue,
    bool success
);

void applyLampState(
    ControlChannel &channel,
    bool desiredState,
    const String &source
);

void applyRemoteCommand(JsonObject command);

void handleInputSignal(ControlChannel &channel);
void handleStateReport(ControlChannel &channel);

void printLampStatus(
    ControlChannel &channel,
    const String &source
);

// ============================================================
// 현재 논리 상태 출력
// ============================================================
void printLampStatus(
    ControlChannel &channel,
    const String &source
)
{
    Serial.print("[");
    Serial.print(channel.outputName);
    Serial.print("] ");

    Serial.print(source);

    Serial.print(" | INPUT=");
    Serial.print(channel.inputState ? "ON" : "OFF");

    Serial.print(" | OUTPUT=");
    Serial.println(channel.outputState ? "ON" : "OFF");
}

// ============================================================
// Wi-Fi 연결
// ============================================================
bool connectWiFi()
{
    if (WiFi.status() == WL_CONNECTED)
    {
        wifiAttemptPending = false;
        return true;
    }

    unsigned long now = millis();

    if (wifiAttemptPending)
    {
        if (now - lastWiFiAttemptMs < WIFI_CONNECT_TIMEOUT_MS)
        {
            return false;
        }

        Serial.print("[WIFI] Connect timeout, status = ");
        Serial.println(static_cast<int>(WiFi.status()));

        wifiAttemptPending = false;
    }

    if (now - lastWiFiAttemptMs < WIFI_RETRY_MS)
    {
        return false;
    }

    lastWiFiAttemptMs = now;
    wifiAttemptPending = true;

    Serial.println();
    Serial.println("[WIFI] Connecting...");

    Serial.print("[WIFI] SSID = ");
    Serial.println(WIFI_SSID);

    WiFi.mode(WIFI_STA);

    if (strlen(WIFI_PASSWORD) == 0)
    {
        WiFi.begin(WIFI_SSID);
    }
    else
    {
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }

    return false;
}

// ============================================================
// WebSocket 시작
// ============================================================
void startWebSocket()
{
    if (wsStarted || WiFi.status() != WL_CONNECTED)
    {
        return;
    }

    WS_PATH =
        String("/ws/device?deviceId=") +
        DEVICE_ID;

    String authorizationHeader =
        String("Authorization: Bearer ") +
        DEVICE_TOKEN;

    webSocket.setExtraHeaders(
        authorizationHeader.c_str()
    );

    webSocket.onEvent(webSocketEvent);

    webSocket.setReconnectInterval(
        WS_RECONNECT_MS
    );

    webSocket.enableHeartbeat(
        WS_PING_INTERVAL_MS,
        WS_PONG_TIMEOUT_MS,
        WS_DISCONNECT_TIMEOUT_COUNT
    );

    if (SERVER_USE_TLS)
    {
        webSocket.beginSSL(
            SERVER_HOST,
            SERVER_PORT,
            WS_PATH.c_str()
        );
    }
    else
    {
        webSocket.begin(
            SERVER_HOST,
            SERVER_PORT,
            WS_PATH
        );
    }

    wsStarted = true;

    Serial.println(
        "[WS] Starting connection"
    );
}

// ============================================================
// Wi-Fi 상태 처리
// ============================================================
void handleWiFi()
{
    bool connected =
        WiFi.status() == WL_CONNECTED;

    if (connected && !wasWiFiConnected)
    {
        wasWiFiConnected = true;
        wifiAttemptPending = false;

        Serial.println();
        Serial.println("[WIFI] Connected");

        Serial.print("[WIFI] IP = ");
        Serial.println(WiFi.localIP());

        Serial.print("[WIFI] RSSI = ");
        Serial.println(WiFi.RSSI());

        startWebSocket();
    }

    if (!connected && wasWiFiConnected)
    {
        wasWiFiConnected = false;

        Serial.println();
        Serial.println(
            "[WIFI] Connection lost"
        );
    }

    if (!connected)
    {
        connectWiFi();
    }
}

// ============================================================
// Hello
//
// 서버에 장치와 논리 채널 정보를 알려줍니다.
// ============================================================
void sendHello()
{
    JsonDocument document;

    document["type"] = "hello";
    document["deviceId"] = DEVICE_ID;
    document["pin"] = DEVICE_PIN_NAME;

    JsonArray inputs =
        document["inputs"].to<JsonArray>();

    inputs.add("IS1");
    inputs.add("IS2");
    inputs.add("IS3");
    inputs.add("IS4");
    inputs.add("IS5");
    inputs.add("IS6");
    inputs.add("IS7");
    inputs.add("IS8");

    JsonArray outputs =
        document["outputs"].to<JsonArray>();

    outputs.add("OS1");
    outputs.add("OS2");
    outputs.add("OS3");
    outputs.add("OS4");
    outputs.add("OS5");
    outputs.add("OS6");
    outputs.add("OS7");
    outputs.add("OS8");

    String payload;

    serializeJson(
        document,
        payload
    );

    webSocket.sendTXT(payload);
}

// ============================================================
// 현재 상태 서버 보고
// ============================================================
void sendStateReport(
    ControlChannel &channel,
    const String &source
)
{
    if (!wsConnected)
    {
        return;
    }

    JsonDocument document;

    document["type"] = "state";
    document["deviceId"] = DEVICE_ID;

    document["pin"] =
        channel.outputName;

    document["state"] =
        channel.outputState
            ? "ON"
            : "OFF";

    document["inputPin"] =
        channel.inputName;

    document["inputState"] =
        channel.inputState
            ? "ON"
            : "OFF";

    document["source"] = source;
    document["IStr"] = channel.inputString;
    document["sendString"] = channel.inputString;
    document["OStr"] = channel.outputString;
    document["receiveString"] = channel.outputString;

    document["ip"] =
        WiFi.localIP().toString();

    String payload;

    serializeJson(
        document,
        payload
    );

    webSocket.sendTXT(payload);

    Serial.print("[STATE] Report = ");
    Serial.print(channel.outputName);
    Serial.print(" = ");
    Serial.println(
        channel.outputState
            ? "ON"
            : "OFF"
    );
}

// ============================================================
// 채널별 문자열 전송 (Wemos -> Server)
// ============================================================
void sendChannelString(ControlChannel &channel)
{
    if (!wsConnected)
    {
        Serial.println("[SEND] WebSocket disconnected");
        return;
    }

    JsonDocument document;
    document["type"] = "channelString";
    document["deviceId"] = DEVICE_ID;
    document["pin"] = channel.outputName;
    document["inputPin"] = channel.inputName;
    document["IStr"] = channel.inputString;
    document["sendString"] = channel.inputString;

    String payload;
    serializeJson(document, payload);
    webSocket.sendTXT(payload);

    Serial.print("[SEND] ");
    Serial.print(channel.outputName);
    Serial.print(" = ");
    Serial.println(channel.inputString);
}

// ============================================================
// ACK
// ============================================================
void sendAck(
    ControlChannel &channel,
    const String &commandId,
    const String &stateValue,
    bool success
)
{
    if (!wsConnected)
    {
        return;
    }

    JsonDocument document;

    document["type"] = "ack";
    document["commandId"] = commandId;
    document["deviceId"] = DEVICE_ID;

    document["pin"] =
        channel.outputName;

    document["state"] =
        stateValue;

    document["success"] =
        success;

    String payload;

    serializeJson(
        document,
        payload
    );

    webSocket.sendTXT(payload);

    Serial.print("[ACK] sent : ");
    Serial.println(commandId);
}

// ============================================================
// 출력 논리 상태 변경
//
// 실제 GPIO는 사용하지 않습니다.
// channel.outputState는 OS1~OS4를 직접 참조합니다.
// ============================================================
void applyLampState(
    ControlChannel &channel,
    bool desiredState,
    const String &source
)
{
    if (channel.outputState ==
        desiredState)
    {
        return;
    }

    bool previousState =
        channel.outputState;

    channel.outputState =
        desiredState;

    Serial.print("[");
    Serial.print(channel.outputName);
    Serial.print("] ");

    Serial.print(
        previousState
            ? "ON"
            : "OFF"
    );

    Serial.print(" -> ");

    Serial.print(
        channel.outputState
            ? "ON"
            : "OFF"
    );

    Serial.print(" | SOURCE=");

    Serial.println(source);

    printLampStatus(
        channel,
        source
    );

    channel.stateReportPending =
        true;

    channel.pendingStateSource =
        source;
}

// ============================================================
// 서버 명령 처리
//
// 예:
// {
//   "type": "command",
//   "commandId": "CMD-001",
//   "pin": "OS1",
//   "state": "ON"
// }
// ============================================================
void applyRemoteCommand(JsonObject command)
{
    String commandId =
        command["commandId"]
            .as<String>();

    if (commandId.length() == 0)
    {
        Serial.println(
            "[CMD] commandId missing"
        );

        return;
    }

    String pinName =
        command["pin"] |
        DEVICE_PIN_NAME;

    ControlChannel *channel =
        nullptr;

    for (ControlChannel &candidate :
         channels)
    {
        if (pinName ==
            candidate.outputName)
        {
            channel = &candidate;
            break;
        }
    }

    if (channel == nullptr)
    {
        Serial.print(
            "[CMD] Unsupported pin = "
        );

        Serial.println(pinName);

        return;
    }

    String receivedString =
        command["OStr"] | (command["receiveString"] | "");

    if (receivedString.length() > 0)
    {
        channel->outputString = receivedString;
        Serial.print("[RECV] ");
        Serial.print(channel->inputName);
        Serial.print(" = ");
        Serial.println(channel->outputString);
    }

    String requestedState =
        command["state"] | "";

    requestedState.toUpperCase();

    if (requestedState != "ON" &&
        requestedState != "OFF")
    {
        Serial.println(
            "[CMD] Invalid state"
        );

        return;
    }

    bool desiredState =
        requestedState == "ON";

    // 같은 명령 ID가 다시 들어오면
    // OS 상태를 다시 변경하지 않습니다.
    if (commandId ==
        channel->lastProcessedCommandId)
    {
        Serial.print(
            "[CMD] Duplicate : "
        );

        Serial.println(commandId);

        sendAck(
            *channel,
            commandId,
            requestedState,
            true
        );

        return;
    }

    Serial.println();
    Serial.println(
        "[CMD] New command"
    );

    Serial.print("[CMD] ID = ");
    Serial.println(commandId);

    Serial.print("[CMD] State = ");
    Serial.println(requestedState);

    Serial.print("[CMD] Pin = ");
    Serial.println(
        channel->outputName
    );

    // OS1~OS4 중 해당 변수 변경
    applyLampState(
        *channel,
        desiredState,
        "CLIENT"
    );

    sendAck(
        *channel,
        commandId,
        requestedState,
        true
    );

    channel->lastProcessedCommandId =
        commandId;

    Serial.println(
        "[CMD] Completed"
    );
}

// ============================================================
// WebSocket 이벤트
// ============================================================
void webSocketEvent(
    WStype_t type,
    uint8_t *payload,
    size_t length
)
{
    switch (type)
    {
    case WStype_DISCONNECTED:

        wsConnected = false;

        Serial.println(
            "[WS] disconnected"
        );

        break;

    case WStype_ERROR:

        Serial.print(
            "[WS] error: "
        );

        if (length > 0)
        {
            Serial.write(
                payload,
                length
            );
        }

        Serial.println();

        break;

    case WStype_CONNECTED:

        wsConnected = true;

        Serial.println(
            "[WS] connected"
        );

        sendHello();

        // 재연결 후 모든 OS 상태를 보고
        for (ControlChannel &channel :
             channels)
        {
            channel.stateReportPending =
                true;

            channel.pendingStateSource =
                "WEMOS";
        }

        break;

    case WStype_TEXT:
    {
        JsonDocument document;

        DeserializationError error =
            deserializeJson(
                document,
                payload,
                length
            );

        if (error)
        {
            Serial.print(
                "[WS] JSON error : "
            );

            Serial.println(
                error.c_str()
            );

            break;
        }

        String msgType =
            document["type"] | "";

        if (msgType == "command")
        {
            applyRemoteCommand(
                document.as<JsonObject>()
            );
        }

        break;
    }

    default:
        break;
    }
}

// ============================================================
// 논리 입력 IS1~IS4 처리
//
// 현재는 IS 상태가 변경되었는지만 감지합니다.
// IS가 변경되었다고 해서 자동으로 OS를 변경하지 않습니다.
//
// 따라서:
//   IS1 = OFF
//   OS1 = ON
//
// 과 같이 입력과 출력이 서로 다른 상태를 유지할 수 있습니다.
//
// IS -> OS 자동 연동이 필요하면 아래 주석 부분을 사용합니다.
// ============================================================
void handleInputSignal(
    ControlChannel &channel
)
{
    bool currentInput =
        channel.inputState;

    if (currentInput !=
        channel.lastRawInput)
    {
        channel.lastRawInput =
            currentInput;

        channel.lastDebounceMs =
            millis();
    }

    if (millis() -
            channel.lastDebounceMs >=
        50)
    {
        if (channel.debouncedInput !=
            currentInput)
        {
            channel.debouncedInput =
                currentInput;

            Serial.print(
                "[INPUT] "
            );

            Serial.print(
                channel.inputName
            );

            Serial.print(" = ");

            Serial.println(
                currentInput
                    ? "ON"
                    : "OFF"
            );

            // ------------------------------------------------
            // IS -> OS 자동 연동을 원하면 다음 줄을 사용
            // ------------------------------------------------
            // applyLampState(
            //     channel,
            //     currentInput,
            //     "WEMOS"
            // );
        }
    }
}

// ============================================================
// 상태 보고 처리
// ============================================================
void handleStateReport(
    ControlChannel &channel
)
{
    if (!wsConnected ||
        !channel.stateReportPending)
    {
        return;
    }

    sendStateReport(
        channel,
        channel.pendingStateSource
    );

    channel.stateReportPending =
        false;
}

// ============================================================
// setup
// ============================================================
void setup()
{
    Serial.begin(115200);

    delay(200);

    Serial.println();
    Serial.println();
    Serial.println(
        "================================"
    );

    Serial.println(
        " Wemos D1 R1 IS/OS Controller"
    );

    Serial.println(
        "================================"
    );

    // 논리 변수 초기 상태
    IS1 = false;
    IS2 = false;
    IS3 = false;
    IS4 = false;

    OS1 = false;
    OS2 = false;
    OS3 = false;
    OS4 = false;

    // 채널 초기화
    for (ControlChannel &channel :
         channels)
    {
        channel.lastRawInput =
            channel.inputState;

        channel.debouncedInput =
            channel.inputState;

        channel.lastDebounceMs =
            millis();

        channel.stateReportPending =
            true;

        channel.pendingStateSource =
            "WEMOS";

        Serial.print(
            "[BOOT] "
        );

        Serial.print(
            channel.inputName
        );

        Serial.print(" = ");

        Serial.print(
            channel.inputState
                ? "ON"
                : "OFF"
        );

        Serial.print(" -> ");

        Serial.print(
            channel.outputName
        );

        Serial.print(" = ");

        Serial.println(
            channel.outputState
                ? "ON"
                : "OFF"
        );
    }

    Serial.print(
        "[BOOT] Device ID = "
    );

    Serial.println(DEVICE_ID);

    // Wi-Fi
    WiFi.persistent(false);
    WiFi.setAutoReconnect(true);
    WiFi.mode(WIFI_STA);

    lastWiFiAttemptMs =
        millis() -
        WIFI_RETRY_MS;

    connectWiFi();

    Serial.println(
        "[BOOT] Setup complete"
    );
}

// ============================================================
// loop
// ============================================================
void loop()
{
    handleWiFi();

    // 논리 입력 처리
    for (ControlChannel &channel :
         channels)
    {
        handleInputSignal(
            channel
        );
    }

    // WebSocket 처리
    if (wsStarted)
    {
        webSocket.loop();
    }

    // 상태 보고
    if (WiFi.status() ==
        WL_CONNECTED)
    {
        for (ControlChannel &channel :
             channels)
        {
            handleStateReport(
                channel
            );
        }
    }
}
