장치 펌웨어 안내
================

1. 개요
-------
펌웨어는 Wi-Fi와 WebSocket으로 서버에 연결해 16개 채널의 논리 입력·출력 상태와 문자열을 주고받습니다. 현재 PlatformIO 설정은 ESP8266 기반 Wemos D1 보드용입니다.

2. 파일 구성
------------
- Device.ino: 네트워크·인증 설정, 보드 핀 설정, Arduino setup()/loop() 및 시험용 사용자 코드
- Device.h: Wi-Fi·WebSocket 통신, JSON 메시지 처리, 16채널 상태 관리 및 입력 디바운스
- ../platformio.ini: PlatformIO 보드·라이브러리·빌드 환경 설정

3. 개발 환경 및 빌드
--------------------
프로젝트 루트에서 PlatformIO를 사용합니다. 라이브러리 의존성은 platformio.ini에 선언되어 있으며, 현재 환경 이름은 device_d1_r1입니다.

```text
pio run -e device_d1_r1
pio run -e device_d1_r1 -t upload
pio device monitor -b 115200
```

업로드할 때는 실제 보드의 시리얼 포트를 선택해야 합니다. PlatformIO 확장을 사용하는 경우 Build, Upload, Monitor 기능을 이용할 수 있습니다.

4. 연결 및 보드 설정
--------------------
Device.ino에서 다음 항목을 대상 환경에 맞게 설정합니다.
- WIFI_SSID / WIFI_PASSWORD: 연결할 Wi-Fi 이름과 비밀번호
- SERVER_HOST / SERVER_PORT / SERVER_USE_TLS: 서버 주소, 포트 및 TLS 사용 여부
- DEVICE_ID / DEVICE_TOKEN: 서버에 등록된 장치 인증 정보
- buttonPin / ledPin: 시험용 입력·출력 핀

Device.h에서 통신 재시도 및 연결 유지 주기를 확인할 수 있습니다. 시간 단위는 밀리초(ms)이며, 기본 출력 신호는 OS1, 논리 채널 수는 16입니다. 인증 토큰과 Wi-Fi 비밀번호를 공개 저장소나 로그에 노출하지 마세요.

5. 채널 데이터
---------------
각 채널 N(1~16)은 다음 값을 사용합니다.
- ISN: 장치 입력의 논리 상태
- OSN: 장치 출력의 논리 상태
- IStrN: 장치에서 서버로 보내는 문자열
- ISStrN: IStrN 독립 전송 요청. true이면 전송을 시도하고, 성공하면 자동으로 false가 됩니다.
- OStrN: 서버에서 받아 보관하는 출력 문자열

이 채널들은 소프트웨어상의 논리 채널입니다. 각 채널을 실제 입력·출력 핀에 연결하려면 별도의 GPIO 매핑과 필요에 따른 I/O 확장 하드웨어가 필요합니다.

6. 통신 동작
-------------
- WebSocket 연결 시 hello 메시지로 채널을 등록하고, 연결 및 상태 변화에 따라 state 메시지로 입력·출력 상태와 IStr·OStr을 보고합니다.
- IS 상태 변화 없이 문자열만 보내려면 해당 채널의 ISStr을 true로 설정합니다. 연결 또는 전송에 실패하면 전송 요청을 유지하고 다시 시도합니다.
- 서버의 ON/OFF 명령은 command 메시지로 전달됩니다. 장치는 해당 OS 상태와 OStr을 갱신하고 ack 및 state 메시지로 처리 결과를 보냅니다. 명령은 입력 IS를 변경하지 않습니다.
- channelString은 출력 상태 변경 없이 IStr만 전송할 때 사용합니다.
- 메시지 종류는 장치 송신 hello, state, channelString, ack와 서버 수신 command입니다.

7. 기본 시험 동작
-----------------
- 시리얼 모니터에서 줄 단위로 입력합니다. `0`은 IS1 OFF와 IStr1="Ch1 off", `1`은 IS1 ON과 IStr1="Ch1 on", `2`는 IStr1="alarm"을 설정합니다. 그 외 문자열은 IStr1에 그대로 설정합니다.
- 시리얼 입력을 처리할 때 ISStr1을 true로 설정하므로 IStr1이 독립 전송됩니다. 성공하면 ISStr1은 자동으로 false가 됩니다.
- 버튼 입력은 INPUT_PULLUP으로 설정되며 50ms 동안 안정된 변화만 반영합니다. HIGH는 IS1 ON, LOW는 IS1 OFF이며 IStr1도 함께 갱신됩니다.
- 시험 펌웨어는 OS1을 ledPin에 출력합니다. 현재 ESP8266 핀 설정은 buttonPin=D7, ledPin=D9입니다. 실제 보드 패키지에서 D9 표기가 지원되는지 확인하세요.

8. 운영 전 확인
----------------
- 현재 설정에서 OS2~OS16 및 추가 입력에는 물리 GPIO 연결이 없습니다. 논리 상태가 실제 설비 출력 상태를 보장하지 않습니다.
- 서버 장치 설정에 채널이 등록되어 있는지 확인한 다음 펌웨어를 빌드·업로드하고, 장치 연결과 채널 상태 보고를 확인합니다.
- 실제 설비에 연결하기 전에 핀 매핑, 출력 극성, 전원 재인가·재부팅 시 동작을 확인하고 부하를 분리한 상태에서 시험하세요.
- 실제 보드 빌드, 배선, 서버 연결은 각각 별도로 검증해야 합니다.
