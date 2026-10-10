
// ============================================================
// 기본 설정: 이 구역만 수정하면 장치의 연결 및 보드 설정을 변경할 수 있습니다.
// 사용 라이브러리: WemosDevice.h"
// ============================================================

// Wi-Fi 설정
// const char *WIFI_SSID = "SK_55B6_2.4G";
// const char *WIFI_PASSWORD = "es+^ue?pce";
const char *WIFI_SSID = "iPhone";
const char *WIFI_PASSWORD = "kims8974";

// 서버 설정: TLS 사용 시 SERVER_PORT는 보통 443입니다.
const char *SERVER_HOST = "port-0-factorysocket-mu479jw776550ef8.sel3.cloudtype.app";
const uint16_t SERVER_PORT = 443;
const bool SERVER_USE_TLS = true;

// 로컬 서버 설정: TLS 사용 시 SERVER_PORT는 보통 443입니다.
// const char *SERVER_HOST = " 172.20.10.2";
// const uint16_t SERVER_PORT = 8080;
// const bool SERVER_USE_TLS = false;

// 장치 인증 정보
const char *DEVICE_ID = "DEVICE-D1-001";
const char *DEVICE_TOKEN = "65494229077631fbb57e46a1a0e5e3c21b502efb69e1548a24b9a2258369c510";
#include "WemosDevice.h"
// ============================================================

// ============================================================
// 아래의 처리 코드는 사용자 지정 코드입니다. 사용자가 프로그램하시면 됩니다.
// ============================================================
// constants won't change. They're used here to set pin numbers:
const int buttonPin = D7;   // the number of the pushbutton pin
const int ledPin = D9;      // the number of the LED pin
bool buttonPinState = HIGH; // 마지막으로 확정된 전기적 핀 상태

void setup()
{
    deviceSetup(); // WemosDevice.h

    // ============================================================
    // 아래의 처리 코드는 사용자 지정 코드입니다. 사용자가 프로그램하시면 됩니다.
    // ============================================================

    // 현재 보드 시험에서는 OS1을 D9에 출력합니다. 다른 채널의 물리 출력은 아직 연결하지 않습니다.
    pinMode(ledPin, OUTPUT);
    pinMode(buttonPin, INPUT_PULLUP);
}

void loop()
{
    deviceLoop(); // WemosDevice.h

    // ============================================================
    // 아래의 처리 코드는 사용자 지정 코드입니다. 사용자가 프로그램하시면 됩니다.
    // ============================================================

    // 시리얼 시험 입력: '0'/'1'은 IS1과 IStr1, '2'는 IStr1만 변경합니다.
    // 입력 감지는 이 블록보다 먼저 실행되므로 IS1 변화는 다음 loop에서 디바운스를 시작합니다.
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

    // 웹 명령 또는 안정된 입력으로 확정된 OS1을 물리 출력에 반영합니다. IS1을 직접 출력하지 않습니다.
    digitalWrite(ledPin, OS1);

    // 50ms 동안 안정된 핀 변화만 처리합니다. INPUT_PULLUP이므로 LOW가 눌림 상태입니다.
    if (pinStateChanged(digitalRead(buttonPin), buttonPinState))
    {
        IS1 = (buttonPinState == LOW);
        IStr1 = IS1 ? "Ch1 on" : "Ch1 off";
    }
}
