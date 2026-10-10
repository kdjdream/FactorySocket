Wemos D1 R1 장치 프로그램 (기본 설정 분리 버전)

파일 구성
- Wemos-D1-002.ino : 사용자가 수정할 기본 설정과 setup()/loop()
- WemosDevice.h    : Wi-Fi/WebSocket/JSON 및 8채널 처리 구현

설치 방법
1. Wemos-D1-002 폴더를 만듭니다.
2. Wemos-D1-002.ino와 WemosDevice.h를 같은 폴더에 둡니다.
3. Arduino IDE에서 Wemos-D1-002.ino를 엽니다.
4. 아래 라이브러리를 설치했는지 확인합니다.
   - ESP8266 보드 패키지
   - WebSockets (WebSocketsClient.h 제공)
   - ArduinoJson
5. .ino 파일 상단의 기본 설정을 수정한 뒤 업로드합니다.

기본 설정 항목
- WIFI_SSID / WIFI_PASSWORD : Wi-Fi 이름과 비밀번호
- SERVER_HOST / SERVER_PORT / SERVER_USE_TLS : 서버 연결 정보
- DEVICE_ID / DEVICE_TOKEN : 서버에 등록된 장치 ID와 토큰
- CHANNEL_COUNT : 현재 프로그램은 8채널 구조를 전제로 합니다. 기능 유지 목적상 8로 유지하세요.
- WIFI_RETRY_MS 등 : Wi-Fi/WebSocket 재연결 및 heartbeat 시간(ms)
- DEVICE_OUTPUT_SIGNAL : 기본 출력 신호 이름 (기본 OS1)
- DEVICE_OUTPUT_PIN : OS1을 물리적으로 출력하는 보드 핀 (기본 D9)
- DEVICE_TEST_SWITCH_PIN : 시험용 스위치 입력 핀 (기본 D7, INPUT_PULLUP)

기존 동작
- 8채널 IS1~IS8 / OS1~OS8 상태 및 IStr/OStr 문자열 관리
- Wi-Fi 연결/재연결과 WebSocket 연결/heartbeat
- hello, state, channelString, ack 메시지 처리
- 서버 command 처리 및 출력 상태 갱신
- 50ms 입력 디바운스 처리
- 시리얼 시험 명령: '0' = IS1 OFF, '1' = IS1 ON, '2' = IStr1을 alarm으로 변경
- OS1 상태를 DEVICE_OUTPUT_PIN으로 출력
- DEVICE_TEST_SWITCH_PIN을 내부 풀업 입력으로 읽어 IS1/IStr1을 갱신

주의
- DEVICE_ID와 DEVICE_TOKEN은 서버에 등록된 실제 값으로 설정하세요. 토큰을 공개 저장소나 로그에 올리지 마세요.
- 원본 코드의 네트워크 인증/프로토콜 동작은 유지했지만, 실제 보드 컴파일 및 서버 연결 시험은 별도로 수행해야 합니다.
- 일부 Wemos D1 R1 호환 보드에서 D9 표기는 보드 패키지에 따라 정의되지 않을 수 있습니다. 기존 보드에서 사용하던 핀 표기가 맞는지 확인하세요.


수정 사항
- IS 변경 시 통신 상태와 관계없이 대응 OS를 즉시 갱신하고 상태 보고를 예약합니다.
- Wi-Fi/WebSocket 미연결 중 보고 예약은 연결 복구 전까지 유지됩니다. 재연결 시 모든 채널의 최신 IS/OS/문자열을 다시 보고합니다.
- pinStateChanged(rawState, pinState)는 50ms 비차단 디바운스를 적용하고 안정된 변화가 있을 때 true를 반환합니다. 상태 변수의 주소를 내부 식별자로 사용하므로 핀 번호 파라미터가 필요 없습니다.
- INPUT_PULLUP 스위치 예제는 LOW를 눌림(ON)으로 처리합니다.
