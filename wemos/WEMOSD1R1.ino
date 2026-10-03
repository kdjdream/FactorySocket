#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>

// ---- 배포 환경 설정 ----
// Wi-Fi 비밀번호가 빈 값이면 비밀번호 없는 네트워크에 연결합니다.
const char *WIFI_SSID = "CSUH_FREE";
const char *WIFI_PASSWORD = "";

// WSS 배포 설정 예시: 호스트에는 프로토콜이나 경로를 넣지 않습니다.
// TLS 사용 시 서버 인증서 검증 정책은 별도로 확인해야 합니다.
// const char *SERVER_HOST = "YOUR_CLOUDTYPE_HOST";
// const uint16_t SERVER_PORT = 443;
// const bool SERVER_USE_TLS = true;

const char *SERVER_HOST = "10.20.36.156";
const uint16_t SERVER_PORT = 8080;
const bool SERVER_USE_TLS = false;

// 서버에 등록한 장치 ID와 발급된 토큰을 사용합니다. 토큰은 로그나 공개 저장소에 노출하지 마세요.
const char *DEVICE_ID = "WEMOS-D1-001";
const char *DEVICE_TOKEN = "65494229077631fbb57e46a1a0e5e3c21b502efb69e1548a24b9a2258369c510";

/*
 * Wemos D1 R1 - 8채널 논리 입력/출력 통신
 *
 * 채널 N의 구성: ISN(입력), OSN(출력), IStrN(송신 문자열), OStrN(수신 문자열).
 * 안정된 IS 변화는 대응 OS를 갱신하고, 서버의 severSignal도 같은 OS를 갱신합니다.
 * 웹 명령 이후에도 다음 입력 변화가 발생하면 그 입력값이 출력에 반영됩니다.
 * 현재 코드는 논리 변수만 다루며 GPIO 읽기/쓰기나 릴레이 구동은 하지 않습니다.
 * 실제 설비 연결 시에는 별도의 GPIO 매핑과 안전한 초기 출력 처리가 필요합니다.
 *
 * 통신 경로: Wi-Fi -> /ws/device WebSocket -> Node.js 서버.
 * 장치 인증: URL에는 deviceId만 넣고 토큰은 Authorization: Bearer 헤더로 전송합니다.
 * 채널 식별: InputSignal="IS1"~"IS8", OutputSignal="OS1"~"OS8".
 * 상태 값: true/false를 JSON의 "ON"/"OFF"로 변환합니다.
 *
 * 송신 메시지: hello(채널 등록), state(상태 보고), channelString(입력 문자열), ack(명령 응답).
 * 수신 메시지: command(severSignal 및 OStr 변경). 실제 출력은 OutputState로 보고합니다.
 * 연결될 때 hello를 먼저 보내고, loop에서 8채널의 현재 상태를 차례로 보고합니다.
 */

const uint8_t CHANNEL_COUNT = 8;

// ---- 채널별 입력 상태: 외부 입력 처리 코드에서 IS1~IS8을 갱신합니다. ----
bool IS1 = false;
bool IS2 = false;
bool IS3 = false;
bool IS4 = false;
bool IS5 = false;
bool IS6 = false;
bool IS7 = false;
bool IS8 = false;

// ---- 채널별 출력 상태: 서버 명령이 대응하는 OS1~OS8을 갱신합니다. ----
bool OS1 = false;
bool OS2 = false;
bool OS3 = false;
bool OS4 = false;
bool OS5 = false;
bool OS6 = false;
bool OS7 = false;
bool OS8 = false;

// ---- 장치 -> 서버 문자열: state 또는 sendChannelString() 호출 시 전송됩니다. ----
// IStr 값의 변경 자체가 전송을 예약하지는 않습니다.
String IStr1 = "";
String IStr2 = "";
String IStr3 = "";
String IStr4 = "";
String IStr5 = "";
String IStr6 = "";
String IStr7 = "";
String IStr8 = "";

// ---- 서버 -> 장치 문자열: command의 OStr를 채널별로 보관합니다. ----
// 빈 문자열은 기존 값을 지우지 않습니다. state 보고에는 보관 중인 OStr도 포함됩니다.
String OStr1 = "";
String OStr2 = "";
String OStr3 = "";
String OStr4 = "";
String OStr5 = "";
String OStr6 = "";
String OStr7 = "";
String OStr8 = "";

// ---- 통신 주기: 시간 값의 단위는 밀리초(ms)입니다. ----
// Wi-Fi는 연결 대기 20초, 재시도 간격 5초를 사용하며 loop를 막지 않습니다.
// WebSocket은 5초마다 재연결하고, ping/pong으로 연결 상태를 확인합니다.
const unsigned long WIFI_RETRY_MS = 5000;
const unsigned long WIFI_CONNECT_TIMEOUT_MS = 20000;
const unsigned long WS_RECONNECT_MS = 5000;
const unsigned long WS_PING_INTERVAL_MS = 15000;
const unsigned long WS_PONG_TIMEOUT_MS = 3000;
const uint8_t WS_DISCONNECT_TIMEOUT_COUNT = 2;


// hello에서 알리는 기본 출력이며, command에 OutputSignal이 없을 때도 이 채널을 사용합니다.
const char *DEVICE_OUTPUT_SIGNAL = "OS1";

String WS_PATH;
WebSocketsClient webSocket;

/*
 * 채널 하나의 상태, 통신 이름, 문자열 및 처리 이력을 묶습니다.
 * 상태와 문자열은 참조(&)이므로 복사본이 아닌 전역 IS/OS/IStr/OStr 변수를 직접 변경합니다.
 * 신호 이름은 JSON의 InputSignal/OutputSignal에 사용하며 물리 GPIO 번호가 아닙니다.
 * 아래 channels 배열의 초기화 순서는 이 구조체의 멤버 선언 순서와 일치해야 합니다.
 */
struct ControlChannel
{
    bool &inputState;  // 해당 채널의 ISN 원본 상태
    bool &outputState; // 해당 채널의 OSN 원본 상태

    const char *inputSignal;  // 입력 식별자: IS1~IS8
    const char *outputSignal; // 출력 식별자: OS1~OS8

    String &inputString;  // 장치에서 보낼 IStrN
    String &outputString; // 서버에서 받은 OStrN

    bool lastRawInput;            // 직전 loop에서 확인한 입력
    bool debouncedInput;          // 50ms 동안 안정된 것으로 확인한 입력
    bool stateReportPending;      // 다음 보고 처리에서 상태를 전송할지 여부
    unsigned long lastDebounceMs; // 입력이 마지막으로 바뀐 millis() 값

    String pendingStateSource;     // 다음 상태 보고의 출처: WEMOS 또는 CLIENT
    String lastProcessedCommandId; // 이 채널에서 마지막으로 처리한 명령 ID
    bool severSignal = false;
};

// ---- 8채널 매핑: 각 행은 같은 번호의 입력·출력·문자열 변수를 연결합니다. ----
ControlChannel channels[CHANNEL_COUNT] = {
    {IS1, OS1, "IS1", "OS1", IStr1, OStr1, false, false, false, 0, "WEMOS", ""},
    {IS2, OS2, "IS2", "OS2", IStr2, OStr2, false, false, false, 0, "WEMOS", ""},
    {IS3, OS3, "IS3", "OS3", IStr3, OStr3, false, false, false, 0, "WEMOS", ""},
    {IS4, OS4, "IS4", "OS4", IStr4, OStr4, false, false, false, 0, "WEMOS", ""},
    {IS5, OS5, "IS5", "OS5", IStr5, OStr5, false, false, false, 0, "WEMOS", ""},
    {IS6, OS6, "IS6", "OS6", IStr6, OStr6, false, false, false, 0, "WEMOS", ""},
    {IS7, OS7, "IS7", "OS7", IStr7, OStr7, false, false, false, 0, "WEMOS", ""},
    {IS8, OS8, "IS8", "OS8", IStr8, OStr8, false, false, false, 0, "WEMOS", ""}};

// ---- 연결 상태 ----
// wsStarted는 클라이언트 초기화 여부, wsConnected는 현재 소켓 연결 여부입니다.
// wasWiFiConnected는 연결/해제 전환 감지, wifiAttemptPending은 Wi-Fi 연결 대기에 사용합니다.
bool wsConnected = false;
bool wsStarted = false;
bool wasWiFiConnected = false;
bool wifiAttemptPending = false;
unsigned long lastWiFiAttemptMs = 0;

// ---- 함수 선언: 연결 관리, 메시지 송수신, 채널 처리 순서로 구성합니다. ----
bool connectWiFi();
void startWebSocket();
void handleWiFi();

void webSocketEvent(
    WStype_t type,
    uint8_t *payload,
    size_t length);

void sendHello();
void sendChannelString(ControlChannel &channel);

void sendStateReport(
    ControlChannel &channel,
    const String &source);

void sendAck(
    ControlChannel &channel,
    const String &commandId,
    const String &stateValue,
    bool success);

void applyOutputState(
    ControlChannel &channel,
    bool desiredState,
    const String &source);

void applyRemoteCommand(JsonObject command);

void handleInputSignal(ControlChannel &channel);
void handleStateReport(ControlChannel &channel);

void printOutputStatus(
    ControlChannel &channel,
    const String &source);

/**
 * 채널의 현재 입력·출력과 변경 출처를 시리얼로 표시합니다.
 * 조회만 수행하며 상태 변경이나 네트워크 전송은 하지 않습니다.
 */
void printOutputStatus(
    ControlChannel &channel,
    const String &source)
{
    Serial.print("[STATUS] InputSignal=");
    Serial.print(channel.inputSignal);
    Serial.print(" inputState=");
    Serial.print(channel.inputState ? "ON" : "OFF");

    Serial.print(" | OutputSignal=");
    Serial.print(channel.outputSignal);
    Serial.print(" OutputState=");
    Serial.print(channel.outputState ? "ON" : "OFF");
    Serial.print(" | severSignal=");
    Serial.print(channel.severSignal ? "ON" : "OFF");
    Serial.print(" | source=");
    Serial.println(source);
}

/**
 * Wi-Fi 연결을 비동기로 시도합니다. 연결 완료 시에만 true를 반환합니다.
 * 연결 대기 중에는 20초까지 기다리고, 재시도 간격은 millis() 차이로 확인합니다.
 * delay로 기다리지 않으므로 연결 대기 중에도 나머지 loop 처리를 계속할 수 있습니다.
 */
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

        Serial.print("[WIFI] Connection timeout | status=");
        Serial.println(static_cast<int>(WiFi.status()));

        wifiAttemptPending = false;
    }

    if (now - lastWiFiAttemptMs < WIFI_RETRY_MS)
    {
        return false;
    }

    lastWiFiAttemptMs = now;
    wifiAttemptPending = true;

    Serial.print("[WIFI] Connecting | SSID=");
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

/**
 * Wi-Fi 연결 후 WebSocket 클라이언트를 한 번 초기화합니다.
 * 장치 ID 경로, 토큰 인증 헤더, 이벤트 콜백, 재연결 및 heartbeat를 설정합니다.
 * SERVER_USE_TLS에 따라 WS/WSS를 선택하며, 이후 소켓 재연결은 라이브러리가 처리합니다.
 */
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
        authorizationHeader.c_str());

    webSocket.onEvent(webSocketEvent);

    webSocket.setReconnectInterval(
        WS_RECONNECT_MS);

    webSocket.enableHeartbeat(
        WS_PING_INTERVAL_MS,
        WS_PONG_TIMEOUT_MS,
        WS_DISCONNECT_TIMEOUT_COUNT);

    if (SERVER_USE_TLS)
    {
        webSocket.beginSSL(
            SERVER_HOST,
            SERVER_PORT,
            WS_PATH.c_str());
    }
    else
    {
        webSocket.begin(
            SERVER_HOST,
            SERVER_PORT,
            WS_PATH);
    }

    wsStarted = true;

    Serial.print("[WS] Connecting | transport=");
    Serial.print(SERVER_USE_TLS ? "WSS" : "WS");
    Serial.print(" | host=");
    Serial.print(SERVER_HOST);
    Serial.print(" | port=");
    Serial.println(SERVER_PORT);
}

/**
 * loop마다 Wi-Fi의 연결/해제 전환을 확인합니다.
 * 최초 연결 시 IP/RSSI를 출력하고 소켓을 초기화하며, 미연결 상태에서는 재접속을 시도합니다.
 * 소켓의 현재 연결 여부는 webSocketEvent()에서 별도로 관리합니다.
 */
void handleWiFi()
{
    bool connected =
        WiFi.status() == WL_CONNECTED;

    if (connected && !wasWiFiConnected)
    {
        wasWiFiConnected = true;
        wifiAttemptPending = false;

        Serial.print("[WIFI] Connected | IP=");
        Serial.print(WiFi.localIP());
        Serial.print(" | RSSI=");
        Serial.print(WiFi.RSSI());
        Serial.println(" dBm");

        startWebSocket();
    }

    if (!connected && wasWiFiConnected)
    {
        wasWiFiConnected = false;

        Serial.println();
        Serial.println(
            "[WIFI] Connection lost");
    }

    if (!connected)
    {
        connectWiFi();
    }
}

/**
 * 소켓 연결 직후 장치 ID, 기본 출력, 8개 입력/출력 이름을 서버에 알립니다.
 * 서버가 채널을 식별할 수 있도록 state 보고보다 먼저 전송합니다.
 * 인증 토큰은 연결 헤더에서 전달하므로 JSON 본문에는 포함하지 않습니다.
 */
void sendHello()
{
    JsonDocument document;

    document["type"] = "hello";
    document["deviceId"] = DEVICE_ID;
    document["OutputSignal"] = DEVICE_OUTPUT_SIGNAL;

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
        payload);

    webSocket.sendTXT(payload);
}

/**
 * 연결된 소켓으로 채널 하나의 현재 상태와 문자열을 전송합니다.
 * OutputSignal은 OSN 식별자, OutputState는 해당 출력의 실제 ON/OFF 상태입니다.
 * InputSignal/inputState는 ISN의 식별자와 현재 입력값을 나타냅니다.
 * inputState는 debouncedInput이 아닌 inputState 원본을 보고합니다.
 * IStr/sendString 및 OStr/receiveString은 각각 같은 값의 호환 필드입니다.
 * source와 장치 IP를 함께 보내며, 미연결 상태에서는 아무것도 전송하지 않습니다.
 */
void sendStateReport(
    ControlChannel &channel,
    const String &source)
{
    if (!wsConnected)
    {
        return;
    }

    JsonDocument document;

    document["type"] = "state";
    document["deviceId"] = DEVICE_ID;

    document["OutputSignal"] =
        channel.outputSignal;

    document["OutputState"] =
        channel.outputState
            ? "ON"
            : "OFF";

    document["InputSignal"] =
        channel.inputSignal;

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
        payload);

    webSocket.sendTXT(payload);

    Serial.print("[STATE TX] OutputSignal=");
    Serial.print(channel.outputSignal);
    Serial.print(" OutputState=");
    Serial.print(channel.outputState ? "ON" : "OFF");
    Serial.print(" | InputSignal=");
    Serial.print(channel.inputSignal);
    Serial.print(" inputState=");
    Serial.print(channel.inputState ? "ON" : "OFF");
    Serial.print(" | source=");
    Serial.println(source);
}

/**
 * 출력 상태를 변경하지 않고 지정 채널의 IStr만 서버로 전송합니다.
 * loop에서 자동 호출하지 않으므로 필요한 위치에서 명시적으로 호출해야 합니다.
 * 예: IStr1 갱신 후 sendChannelString(channels[0])을 호출합니다.
 */
void sendChannelString(ControlChannel &channel)
{
    if (!wsConnected)
    {
        Serial.print("[STRING TX] Skipped | InputSignal=");
        Serial.print(channel.inputSignal);
        Serial.println(" | WebSocket disconnected");
        return;
    }

    JsonDocument document;
    document["type"] = "channelString";
    document["deviceId"] = DEVICE_ID;
    document["OutputSignal"] = channel.outputSignal;
    document["InputSignal"] = channel.inputSignal;
    document["IStr"] = channel.inputString;
    document["sendString"] = channel.inputString;

    String payload;
    serializeJson(document, payload);
    webSocket.sendTXT(payload);

    Serial.print("[STRING TX] IStr");
    Serial.print(channel.inputSignal + 2);
    Serial.print("=");
    Serial.println(channel.inputString);
}

/**
 * commandId, OutputSignal, 실제 OutputState와 처리 결과를 서버에 응답합니다.
 * 현재 호출 경로는 유효한 명령 또는 중복 명령에 success=true로 응답합니다.
 * 잘못된 ID/채널/상태는 명령 처리 함수에서 반환하므로 실패 ACK는 보내지 않습니다.
 * ACK는 논리 명령 처리 결과이며, 실제 GPIO나 설비의 동작 확인을 뜻하지 않습니다.
 */
void sendAck(
    ControlChannel &channel,
    const String &commandId,
    const String &stateValue,
    bool success)
{
    if (!wsConnected)
    {
        return;
    }

    JsonDocument document;

    document["type"] = "ack";
    document["commandId"] = commandId;
    document["deviceId"] = DEVICE_ID;

    document["OutputSignal"] =
        channel.outputSignal;

    document["OutputState"] =
        stateValue;

    document["success"] =
        success;

    String payload;

    serializeJson(
        document,
        payload);

    webSocket.sendTXT(payload);

    Serial.print("[ACK TX] commandId=");
    Serial.print(commandId);
    Serial.print(" | OutputSignal=");
    Serial.print(channel.outputSignal);
    Serial.print(" OutputState=");
    Serial.print(stateValue);
    Serial.print(" | success=");
    Serial.println(success ? "true" : "false");
}

/**
 * 상태 보고를 항상 예약하고, 기존 상태와 다를 때만 해당 OSN 참조를 변경합니다.
 * 같은 상태의 요청도 입력값·문자열·현재 출력을 서버와 다시 동기화합니다.
 * 실제 전송은 handleStateReport()에서 수행하며 GPIO 출력은 하지 않습니다.
 * 전송 전에 여러 번 변경되면 마지막 상태와 출처가 보고됩니다.
 */
void applyOutputState(
    ControlChannel &channel,
    bool desiredState,
    const String &source)
{
    channel.stateReportPending = true;
    channel.pendingStateSource = source;

    if (channel.outputState ==
        desiredState)
    {
        return;
    }

    bool previousState =
        channel.outputState;

    channel.outputState =
        desiredState;

    Serial.print("[OUTPUT] OutputSignal=");
    Serial.print(channel.outputSignal);
    Serial.print(" | OutputState=");

    Serial.print(
        previousState
            ? "ON"
            : "OFF");

    Serial.print(" -> ");

    Serial.print(
        channel.outputState
            ? "ON"
            : "OFF");

    Serial.print(" | source=");

    Serial.println(source);

    printOutputStatus(
        channel,
        source);
}

/**
 * 서버의 command를 해당 출력 채널에 적용합니다.
 * 예: {"type":"command","commandId":"CMD-001","OutputSignal":"OS1", "severSignal":"ON","OStr":"MOTOR_ON"}
 * commandId가 없거나 채널/상태가 잘못되면 로그를 출력하고 반환합니다.
 * OutputSignal이 생략되면 DEVICE_OUTPUT_SIGNAL을 사용하며 severSignal은 대문자로 정규화합니다.
 * 이전 서버의 state 필드도 수신 호환용으로 허용합니다. 요청값은 채널별 severSignal에 저장합니다.
 * 입력 ISN은 변경하지 않습니다. 서버가 보내는 InputSignal은 여기서 제어에 사용하지 않습니다.
 * OStr(receiveString 호환)는 비어 있지 않을 때만 저장하며 상태 검증·중복 검사보다 먼저 적용됩니다.
 */
void applyRemoteCommand(JsonObject command)
{
    String commandId =
        command["commandId"]
            .as<String>();

    if (commandId.length() == 0)
    {
        Serial.println(
            "[CMD RX] Rejected | commandId missing");

        return;
    }

    String outputSignal =
        command["OutputSignal"] |
        DEVICE_OUTPUT_SIGNAL;

    ControlChannel *channel =
        nullptr;

    for (ControlChannel &candidate :
         channels)
    {
        if (outputSignal ==
            candidate.outputSignal)
        {
            channel = &candidate;
            break;
        }
    }

    if (channel == nullptr)
    {
        Serial.print(
            "[CMD RX] Rejected | unsupported OutputSignal=");

        Serial.println(outputSignal);

        return;
    }

    String receivedString =
        command["OStr"] | (command["receiveString"] | "");

    if (receivedString.length() > 0)
    {
        channel->outputString = receivedString;
        Serial.print("[STRING RX] OStr");
        Serial.print(channel->outputSignal + 2);
        Serial.print("=");
        Serial.println(channel->outputString);
    }

    String requestedState =
        command["severSignal"] | (command["state"] | "");

    requestedState.toUpperCase();

    if (requestedState != "ON" &&
        requestedState != "OFF")
    {
        Serial.print("[CMD RX] Rejected | OutputSignal=");
        Serial.print(channel->outputSignal);
        Serial.print(" | invalid severSignal=");
        Serial.println(requestedState);

        return;
    }

    bool desiredState =
        requestedState == "ON";
    channel->severSignal = desiredState;

    // 채널별 마지막 ID와 같으면 출력을 다시 적용하지 않고 현재 상태의 ACK와 보고를 보냅니다.
    // OStr 처리는 이 검사보다 앞에 있으며, 더 오래된 ID까지 모두 기억하는 방식은 아닙니다.
    if (commandId ==
        channel->lastProcessedCommandId)
    {
        Serial.print(
            "[CMD RX] Duplicate | commandId=");
        Serial.print(commandId);
        Serial.print(" | OutputSignal=");
        Serial.print(channel->outputSignal);
        Serial.print(" | actual OutputState=");
        Serial.println(channel->outputState ? "ON" : "OFF");

        sendAck(
            *channel,
            commandId,
            channel->outputState ? "ON" : "OFF",
            true);
        channel->stateReportPending = true;

        return;
    }

    Serial.print("[CMD RX] commandId=");
    Serial.print(commandId);
    Serial.print(" | OutputSignal=");
    Serial.print(channel->outputSignal);
    Serial.print(" | severSignal=");
    Serial.println(requestedState);

    // 해당 OS1~OS8을 변경하고 CLIENT 출처의 보고를 예약한 뒤 ACK를 먼저 전송합니다.
    applyOutputState(
        *channel,
        channel->severSignal,
        "CLIENT");

    sendAck(
        *channel,
        commandId,
        channel->outputState ? "ON" : "OFF",
        true);

    channel->lastProcessedCommandId =
        commandId;

    Serial.print("[CMD RX] Applied | commandId=");
    Serial.print(commandId);
    Serial.print(" | OutputSignal=");
    Serial.print(channel->outputSignal);
    Serial.print(" OutputState=");
    Serial.println(channel->outputState ? "ON" : "OFF");
}

/**
 * 소켓 연결·해제·오류와 서버 텍스트 메시지를 처리합니다.
 * 연결 시 hello를 보내고 전 채널의 WEMOS 출처 보고를 예약해 서버 상태를 동기화합니다.
 * 텍스트는 전달받은 길이로 JSON 파싱하며 command 타입만 실행합니다.
 * 해제 시 현재 연결 플래그만 내리고, 재연결 자체는 라이브러리에 맡깁니다.
 */
void webSocketEvent(
    WStype_t type,
    uint8_t *payload,
    size_t length)
{
    switch (type)
    {
    case WStype_DISCONNECTED:

        wsConnected = false;

        Serial.println(
            "[WS] Disconnected");

        break;

    case WStype_ERROR:

        Serial.print(
            "[WS] Error | detail=");

        if (length > 0)
        {
            Serial.write(
                payload,
                length);
        }

        Serial.println();

        break;

    case WStype_CONNECTED:

        wsConnected = true;

        Serial.println(
            "[WS] Connected");

        sendHello();

        // 최초 연결과 재연결 모두 8채널의 입력·출력·문자열을 다음 loop에서 보고합니다.
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
                length);

        if (error)
        {
            Serial.print(
                "[WS RX] Invalid JSON | error=");

            Serial.println(
                error.c_str());

            break;
        }

        String msgType =
            document["type"] | "";

        if (msgType == "command")
        {
            applyRemoteCommand(
                document.as<JsonObject>());
        }

        break;
    }

    default:
        break;
    }
}

/**
 * IS1~IS8의 변경을 감지하고 50ms 동안 안정된 입력을 debouncedInput에 기록합니다.
 * 확정된 입력을 해당 OS에 적용하고 WEMOS 출처의 상태 보고를 예약합니다.
 * 출력이 이미 같은 값이더라도 바뀐 입력 상태를 서버에 보고합니다.
 * 웹 제어는 입력 자체를 바꾸지 않으므로 다음 입력 변화 전까지 IS와 OS가 다를 수 있습니다.
 */
void handleInputSignal(
    ControlChannel &channel)
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
                "[INPUT] InputSignal=");

            Serial.print(
                channel.inputSignal);

            Serial.print(" | debounced inputState=");

            Serial.println(
                currentInput
                    ? "ON"
                    : "OFF");

            applyOutputState(
                channel,
                currentInput,
                "WEMOS");
        }
    }
}

/**
 * 소켓이 연결되고 보고 예약이 있는 채널만 state를 전송한 뒤 예약을 해제합니다.
 * 미연결 상태에서는 예약을 유지하며, 재연결 이벤트가 전 채널 보고를 다시 예약합니다.
 * 전송은 별도 서버 수신 확인 없이 처리되므로 이 함수 자체가 전달 보장을 하지는 않습니다.
 */
void handleStateReport(
    ControlChannel &channel)
{
    if (!wsConnected ||
        !channel.stateReportPending)
    {
        return;
    }

    sendStateReport(
        channel,
        channel.pendingStateSource);

    channel.stateReportPending =
        false;
}

/**
 * 부팅 시 한 번 실행합니다. 시리얼, 채널 추적 상태 및 Wi-Fi를 초기화합니다.
 * 전역 선언에서 8채널 모두 OFF/빈 문자열로 시작하며, 초기 상태 보고를 예약합니다.
 * WebSocket 초기화는 Wi-Fi 연결이 확인된 뒤 handleWiFi()에서 수행합니다.
 */
void setup()
{
    Serial.begin(115200);

    delay(200);

    Serial.println();
    Serial.println();
    Serial.println(
        "================================");

    Serial.println(
        " Wemos D1 R1 IS/OS Controller");

    Serial.println(
        "================================");

    // 1~4채널을 명시적으로 OFF로 재설정합니다. 5~8채널은 전역 초기값 OFF를 유지합니다.
    IS1 = false;
    IS2 = false;
    IS3 = false;
    IS4 = false;

    OS1 = false;
    OS2 = false;
    OS3 = false;
    OS4 = false;

    // 현재 입력을 기준으로 디바운스 이력을 초기화하고 8채널의 최초 보고를 예약합니다.
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
            "[BOOT] InputSignal=");

        Serial.print(
            channel.inputSignal);

        Serial.print(" inputState=");

        Serial.print(
            channel.inputState
                ? "ON"
                : "OFF");

        Serial.print(" | OutputSignal=");

        Serial.print(
            channel.outputSignal);

        Serial.print(" OutputState=");

        Serial.println(
            channel.outputState
                ? "ON"
                : "OFF");
    }

    Serial.print(
        "[BOOT] deviceId=");

    Serial.println(DEVICE_ID);

    // Wi-Fi 설정의 플래시 반복 저장을 끄고 STA 모드와 자동 재연결을 설정합니다.
    WiFi.persistent(false);
    WiFi.setAutoReconnect(true);
    WiFi.mode(WIFI_STA);

    // 첫 연결 시도는 재시도 간격을 기다리지 않도록 기준 시각을 앞당깁니다.
    lastWiFiAttemptMs =
        millis() -
        WIFI_RETRY_MS;

    connectWiFi();

    Serial.println(
        "[BOOT] Setup complete");
}

/**
 * Wi-Fi 관리 -> 8채널 입력 감지 -> 소켓 이벤트 처리 -> 예약된 상태 보고 순서로 반복합니다.
 * 소켓 명령으로 예약된 보고도 같은 반복의 마지막 단계에서 처리할 수 있습니다.
 * 안정된 입력 변화와 서버 명령이 보고를 예약합니다. 문자열만의 변화나 시간 경과로는 예약하지 않습니다.
 */
void loop()
{
    handleWiFi();

    // 외부 코드가 갱신한 논리 입력의 변화를 확인합니다.
    for (ControlChannel &channel :
         channels)
    {
        handleInputSignal(
            channel);
    }

    // 재연결, heartbeat, 서버 명령 수신 및 이벤트 콜백을 진행합니다.
    if (wsStarted)
    {
        webSocket.loop();
    }

    // Wi-Fi와 소켓이 연결된 채널 중 보고 예약이 있는 채널만 전송합니다.
    if (WiFi.status() ==
        WL_CONNECTED)
    {
        for (ControlChannel &channel :
             channels)
        {
            handleStateReport(
                channel);
        }
    }

   // kdj
    while (Serial.available() > 0)
    {
        char input = Serial.read(); // 1바이트 문자 읽기

        if (input == '0')
        {
            IS1 = false;
            IStr1 = "Ch1 off";
        }
        else if (input == '1')
        {

            IS1 = true;
            IStr1 = "Ch1 on";
        }
         else if (input == '2')
        {

            IStr1 = "alarm";
        }
        if (input == '0' || input == '1' || input == '2')
        {
            Serial.print("[SERIAL RX] key=");
            Serial.print(input);
            Serial.print(" | IS1=");
            Serial.print(IS1 ? "ON" : "OFF");
            Serial.print(" | IStr1=");
            Serial.println(IStr1);
        }
        // 엔터키 문자('\r', '\n')나 공백은 조건문에서 자연스럽게 무시됨
    }
}
