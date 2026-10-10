-- 신규 설치 전용입니다. factory가 이미 있으면 중단하며 기존 DB를 삭제하거나 이전하지 않습니다.
CREATE DATABASE factory
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE factory;

-- 회원 상태와 권한의 기준 테이블입니다. 승인 담당자가 삭제되어도 회원은 보존합니다.
CREATE TABLE user_profile (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  user_name VARCHAR(100) NOT NULL DEFAULT '',
  region VARCHAR(100) NOT NULL DEFAULT '',
  company VARCHAR(150) NOT NULL DEFAULT '',
  position VARCHAR(100) NOT NULL DEFAULT '',
  phone VARCHAR(20) NOT NULL DEFAULT '',
  email VARCHAR(254) NULL DEFAULT NULL,
  role ENUM('USER','MASTER') NOT NULL DEFAULT 'USER',
  permission_level TINYINT UNSIGNED NOT NULL DEFAULT 1,
  admin_memo TEXT NULL,
  user_request_at DATETIME NULL,
  user_status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  approved_at DATETIME NULL,
  approved_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_profile_approved_by FOREIGN KEY (approved_by) REFERENCES user_profile(user_id) ON DELETE SET NULL,
  UNIQUE KEY uq_user_profile_email (email),
  KEY idx_user_profile_status (user_status),
  KEY idx_user_profile_permission_level (permission_level),
  KEY idx_user_profile_created_at (created_at)
) ENGINE=InnoDB;

-- 생산 현황을 저장합니다. 변경 회원이 삭제되면 변경자 참조만 비웁니다.
CREATE TABLE product (
  product_id INT AUTO_INCREMENT PRIMARY KEY,
  product_code VARCHAR(50) NOT NULL UNIQUE,
  product_name VARCHAR(100) NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  target_quantity INT NOT NULL DEFAULT 100,
  product_status VARCHAR(20) NOT NULL DEFAULT '대기',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  updated_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_product_updated_by FOREIGN KEY (updated_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 회원별 개인 설정입니다. 회원 삭제 시 해당 설정도 함께 삭제합니다.
CREATE TABLE user_setting (
  user_id INT NOT NULL PRIMARY KEY,
  sound_type VARCHAR(20) NOT NULL DEFAULT 'bell',
  sound_volume TINYINT UNSIGNED NOT NULL DEFAULT 50,
  sound_enabled TINYINT(1) NOT NULL DEFAULT 1,
  theme VARCHAR(10) NOT NULL DEFAULT 'light',
  display_mode VARCHAR(10) NOT NULL DEFAULT 'normal',
  show_summary TINYINT(1) NOT NULL DEFAULT 1,
  show_target TINYINT(1) NOT NULL DEFAULT 1,
  show_rate TINYINT(1) NOT NULL DEFAULT 1,
  show_updated_at TINYINT(1) NOT NULL DEFAULT 1,
  show_updated_by TINYINT(1) NOT NULL DEFAULT 1,
  show_device_istr TINYINT(1) NOT NULL DEFAULT 1,
  show_device_ostr TINYINT(1) NOT NULL DEFAULT 1,
  show_device_ostr_inputs TINYINT(1) NOT NULL DEFAULT 1,
  date_format VARCHAR(10) NOT NULL DEFAULT 'ko-KR',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_setting_user FOREIGN KEY (user_id) REFERENCES user_profile(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO product
  (product_code, product_name, quantity, target_quantity, product_status)
VALUES
  ('P-001', '제품 A', 120, 500, '생산중'),
  ('P-002', '제품 B', 250, 500, '생산중'),
  ('P-003', '제품 C', 80, 300, '대기'),
  ('P-004', '제품 D', 420, 500, '완료'),
  ('P-005', '제품 E', 65, 200, '정지');

-- 장치 등록·인증·접속 정보입니다. token_hash는 토큰 원본이 아닌 SHA-256 해시를 보관합니다.
CREATE TABLE device (
 device_row_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id VARCHAR(100) NOT NULL,
 device_name VARCHAR(100) NOT NULL DEFAULT '', token_hash CHAR(64) NULL, is_active TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0,
 last_change_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
 last_ip VARCHAR(45) NULL, last_seen_at DATETIME(3) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(device_row_id), UNIQUE KEY uq_device_device_id(device_id)
) ENGINE=InnoDB;
-- 실제 8채널 상태의 기준입니다. 같은 번호의 IS/OS와 송수신 문자열을 각각 보관합니다.
CREATE TABLE device_channel (
 channel_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id VARCHAR(100) NOT NULL,
 channel_name VARCHAR(100) NOT NULL, input_signal VARCHAR(20) NOT NULL, output_signal VARCHAR(20) NOT NULL,
 is_active TINYINT(1) NOT NULL DEFAULT 1, output_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
 input_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
 last_change_source VARCHAR(100) NOT NULL DEFAULT 'BOOT', input_message TEXT NULL, output_message TEXT NULL, sort_order INT NOT NULL DEFAULT 0,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(channel_id), UNIQUE KEY uq_device_channel_input(device_id,input_signal), UNIQUE KEY uq_device_channel_output(device_id,output_signal),
 CONSTRAINT fk_device_channel_device FOREIGN KEY(device_id) REFERENCES device(device_id) ON DELETE CASCADE
) ENGINE=InnoDB;
-- 웹 요청과 장치 처리 상태를 기록합니다. 명령 전송 완료와 실제 출력 적용 성공은 구분합니다.
CREATE TABLE device_schedule (
  schedule_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id VARCHAR(100) NOT NULL,
  output_signal VARCHAR(20) NOT NULL,
  schedule_name VARCHAR(150) NOT NULL DEFAULT '',
  action_state ENUM('ON','OFF') NOT NULL,
  ostr_payload TEXT NULL,
  repeat_type ENUM('ONCE','HOURLY','DAILY','WEEKLY','MONTHLY','YEARLY') NOT NULL DEFAULT 'ONCE',
  schedule_time DATETIME(3) NULL,
  hour_value TINYINT UNSIGNED NULL,
  minute_value TINYINT UNSIGNED NOT NULL DEFAULT 0,
  weekday_mask TINYINT UNSIGNED NULL,
  day_of_month TINYINT UNSIGNED NULL,
  month_value TINYINT UNSIGNED NULL,
  day_value TINYINT UNSIGNED NULL,
  is_month_end TINYINT(1) NOT NULL DEFAULT 0,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  next_run_at DATETIME(3) NULL,
  last_run_at DATETIME(3) NULL,
  last_execution_status VARCHAR(20) NOT NULL DEFAULT 'WAITING',
  last_execution_message TEXT NULL,
  created_by INT NULL,
  updated_by INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (schedule_id),
  KEY idx_schedule_due (is_enabled,next_run_at),
  KEY idx_schedule_channel (device_id,output_signal),
  KEY idx_schedule_owner (created_by),
  CONSTRAINT fk_schedule_device FOREIGN KEY (device_id) REFERENCES device(device_id) ON DELETE CASCADE,
  CONSTRAINT fk_schedule_creator FOREIGN KEY (created_by) REFERENCES user_profile(user_id) ON DELETE SET NULL,
  CONSTRAINT fk_schedule_updater FOREIGN KEY (updated_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE device_command (
 command_row_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, command_id CHAR(36) NOT NULL, device_id VARCHAR(100) NOT NULL,
 output_signal VARCHAR(20) NOT NULL DEFAULT 'OS1',
 requested_output_state ENUM('ON','OFF') NOT NULL, output_message TEXT NULL, istr_payload TEXT NULL, requested_by VARCHAR(100) NOT NULL DEFAULT 'CLIENT',
 command_status ENUM('PENDING','DELIVERED','ACKED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
 status_changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(command_row_id), UNIQUE KEY uq_device_command_id(command_id), KEY idx_device_poll(device_id,command_status,command_row_id),
 CONSTRAINT fk_device_command_device FOREIGN KEY(device_id) REFERENCES device(device_id) ON DELETE CASCADE
) ENGINE=InnoDB;
-- 출력이 바뀐 순간의 이력입니다. 당시 문자열을 복사하므로 현재 채널 문자열이 바뀌어도 유지됩니다.
CREATE TABLE device_state_history (
 history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id VARCHAR(100) NOT NULL, output_signal VARCHAR(20) NOT NULL DEFAULT 'OS1',
 previous_output_state ENUM('ON','OFF') NULL, output_state ENUM('ON','OFF') NOT NULL, change_source VARCHAR(100) NOT NULL,
 command_id CHAR(36) NULL,
 signal_message TEXT NULL,
 changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(history_id), KEY idx_device_history(device_id,changed_at),
 CONSTRAINT fk_device_history_device FOREIGN KEY(device_id) REFERENCES device(device_id) ON DELETE CASCADE
) ENGINE=InnoDB;
-- 예시 장치는 토큰이 없는 상태입니다. 실제 연결 전에 환경변수 또는 장치 등록으로 인증을 설정해야 합니다.
INSERT INTO device(device_id,device_name,last_change_source) VALUES('DEVICE-D1-001','DEVICE-D1-001','BOOT');

INSERT INTO device_channel(device_id,channel_name,input_signal,output_signal,sort_order) VALUES
('DEVICE-D1-001','채널 01','IS1','OS1',0),('DEVICE-D1-001','채널 02','IS2','OS2',1),('DEVICE-D1-001','채널 03','IS3','OS3',2),('DEVICE-D1-001','채널 04','IS4','OS4',3),('DEVICE-D1-001','채널 05','IS5','OS5',4),('DEVICE-D1-001','채널 06','IS6','OS6',5),('DEVICE-D1-001','채널 07','IS7','OS7',6),('DEVICE-D1-001','채널 08','IS8','OS8',7);
