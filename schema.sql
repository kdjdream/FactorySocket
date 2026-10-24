-- 신규 설치 전용입니다. factory가 이미 있으면 중단하며 기존 DB를 삭제하거나 이전하지 않습니다.
CREATE DATABASE factory
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE factory;

CREATE TABLE company_organization (
  organization_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  group_code CHAR(3) NOT NULL,
  company CHAR(3)  NULL,
  site CHAR(3)  NULL,
  department CHAR(3)  NULL,
  job CHAR(3)  NULL,
  group_name VARCHAR(40) NOT NULL DEFAULT '',
  company_name VARCHAR(40) NULL DEFAULT NULL,
  site_name VARCHAR(40) NULL DEFAULT NULL,
  department_name VARCHAR(40) NULL DEFAULT NULL,
  job_name VARCHAR(40) NULL DEFAULT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_organization_codes (group_code,company,site,department,job),
  CONSTRAINT chk_organization_code_lengths CHECK (CHAR_LENGTH(group_code)=3 AND CHAR_LENGTH(company)=3 AND CHAR_LENGTH(site)=3 AND CHAR_LENGTH(department)=3 AND CHAR_LENGTH(job)=3)
) ENGINE=InnoDB;

-- 회원 상태와 권한의 기준 테이블입니다. 승인 담당자가 삭제되어도 회원은 보존합니다.
CREATE TABLE user_profile (
  user_id INT AUTO_INCREMENT PRIMARY KEY,
  login_id VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  user_name VARCHAR(100) NOT NULL DEFAULT '',
  organization_id INT UNSIGNED NULL,
  signup_department_code CHAR(3) NULL,
  signup_role_code CHAR(3) NULL,
  phone VARCHAR(20) NULL DEFAULT NULL,
  address VARCHAR(255) NULL DEFAULT NULL,
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
  CONSTRAINT fk_user_profile_organization FOREIGN KEY (organization_id) REFERENCES company_organization(organization_id) ON DELETE SET NULL,
  UNIQUE KEY uq_user_profile_email (email),
  UNIQUE KEY uq_user_profile_phone (phone),
  UNIQUE KEY uq_user_profile_signup_codes (signup_department_code,signup_role_code),
  KEY idx_user_profile_status (user_status),
  KEY idx_user_profile_permission_level (permission_level),
  KEY idx_user_profile_created_at (created_at)
) ENGINE=InnoDB;

CREATE TABLE user_register_comment (
  comment_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  login_id VARCHAR(50) NOT NULL,
  event_type ENUM('APPLICATION','REAPPLICATION','APPROVAL','REJECTION','SUSPENSION','STATUS','LEVEL_CHANGE_REQUEST','ORGANIZATION_CHANGE_REQUEST','WITHDRAWAL_REQUEST','WITHDRAWAL_REJECTION','WITHDRAWAL_APPROVAL','DELETION') NOT NULL,
  comment TEXT NOT NULL,
  actor_user_id INT NULL,
  actor_login_id VARCHAR(50) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  request_comment_id BIGINT UNSIGNED NULL,
  KEY idx_register_comment_user (user_id,created_at,comment_id),
  KEY idx_register_comment_login (login_id,created_at),
  KEY idx_register_comment_request (request_comment_id,event_type),
  CONSTRAINT fk_register_comment_user FOREIGN KEY (user_id) REFERENCES user_profile(user_id) ON DELETE SET NULL,
  CONSTRAINT fk_register_comment_actor FOREIGN KEY (actor_user_id) REFERENCES user_profile(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE site_permission_policy (
  poicy_id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  site_name VARCHAR(100) NOT NULL,
  default_leble TINYINT UNSIGNED NOT NULL DEFAULT 1,
  permisson_lebel TINYINT UNSIGNED NOT NULL DEFAULT 1,
  updated_by INT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  UNIQUE KEY uq_permission_site (site_name),
  CONSTRAINT chk_permission_level CHECK (permisson_lebel BETWEEN 1 AND 20)
) ENGINE=InnoDB;

INSERT INTO site_permission_policy (poicy_id,site_name,default_leble,permisson_lebel) VALUES
(1,'/product-view.html',1,1),(2,'/product-control.html',12,12),(3,'/product-report.html',12,12),
(4,'/product-admin.html',14,14),(5,'/product-channel-link.html',16,16),(6,'/device-view.html',1,1),
(7,'/device-control.html',8,8),(8,'/user_customization.html',10,10),(9,'/device_schedule.html',14,14),
(10,'/device-admin.html',16,16),(11,'/device-report.html',16,16),(12,'/user-profile.html',1,1),
(13,'/user-setting.html',1,1),(14,'/user-level.html',20,20),(15,'/user-admin.html',16,16),
(16,'/user-company.html',16,16);

-- 생산 현황을 저장합니다. 변경 회원이 삭제되면 변경자 참조만 비웁니다.
CREATE TABLE product (
  product_id INT AUTO_INCREMENT PRIMARY KEY,
  product_code VARCHAR(50) NOT NULL UNIQUE,
  product_name VARCHAR(100) NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  work_quantity INT NOT NULL DEFAULT 0,
  target_quantity INT NOT NULL DEFAULT 100,
  quantity_reason VARCHAR(500) NOT NULL DEFAULT '',
  quantity_actor VARCHAR(150) NOT NULL DEFAULT '',
  quantity_change_type VARCHAR(30) NOT NULL DEFAULT 'LEGACY',
  product_status VARCHAR(20) NOT NULL DEFAULT '대기',
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  updated_by INT NULL,
  updated_by_label VARCHAR(100) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_product_updated_by FOREIGN KEY (updated_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE product_quantity_history (
  history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  work_quantity INT NULL,
  target_quantity INT NULL,
  previous_product_status VARCHAR(20) NULL,
  product_status VARCHAR(20) NULL,
  change_source VARCHAR(100) NOT NULL DEFAULT '',
  change_reason VARCHAR(500) NOT NULL DEFAULT '',
  changed_by_user_id INT NULL,
  changed_by_username VARCHAR(150) NULL,
  change_type VARCHAR(30) NOT NULL DEFAULT 'LEGACY',
  changed_at DATETIME(3) NOT NULL,
  PRIMARY KEY(history_id), KEY idx_product_quantity_history(product_id,changed_at),
  CONSTRAINT fk_product_quantity_history FOREIGN KEY(product_id) REFERENCES product(product_id) ON DELETE CASCADE
) ENGINE=InnoDB;

DELIMITER $$
CREATE TRIGGER product_quantity_insert AFTER INSERT ON product FOR EACH ROW
BEGIN
  INSERT INTO product_quantity_history(product_id,quantity,work_quantity,target_quantity,previous_product_status,product_status,change_source,change_reason,changed_by_user_id,changed_by_username,change_type,changed_at)
  VALUES(NEW.product_id,NEW.quantity,NEW.work_quantity,NEW.target_quantity,NULL,NEW.product_status,COALESCE(NULLIF(NEW.updated_by_label,''),NULLIF(NEW.quantity_actor,''),CAST(NEW.updated_by AS CHAR),'BASELINE'),CASE WHEN NEW.quantity_change_type='DEVICE' THEN '' ELSE COALESCE(NULLIF(NEW.quantity_reason,''),'기준 수량 등록') END,NEW.updated_by,CASE WHEN NEW.quantity_change_type='DEVICE' THEN CASE WHEN LEFT(NEW.quantity_actor,7)='DEVICE:' THEN SUBSTRING(NEW.quantity_actor,8) ELSE NEW.quantity_actor END ELSE COALESCE(NULLIF(NEW.quantity_actor,''),(SELECT login_id FROM user_profile WHERE user_id=NEW.updated_by LIMIT 1)) END,NEW.quantity_change_type,UTC_TIMESTAMP(3)+INTERVAL 9 HOUR);
END$$
CREATE TRIGGER product_quantity_update AFTER UPDATE ON product FOR EACH ROW
BEGIN
  IF NOT (NEW.quantity <=> OLD.quantity) OR NOT (NEW.work_quantity <=> OLD.work_quantity) OR NOT (NEW.target_quantity <=> OLD.target_quantity) OR NOT (NEW.product_status <=> OLD.product_status) THEN
    INSERT INTO product_quantity_history(product_id,quantity,work_quantity,target_quantity,previous_product_status,product_status,change_source,change_reason,changed_by_user_id,changed_by_username,change_type,changed_at)
    VALUES(NEW.product_id,NEW.quantity,NEW.work_quantity,NEW.target_quantity,OLD.product_status,NEW.product_status,COALESCE(NULLIF(NEW.updated_by_label,''),NULLIF(NEW.quantity_actor,''),CAST(NEW.updated_by AS CHAR),'BASELINE'),CASE WHEN NEW.quantity_change_type='DEVICE' THEN '' ELSE COALESCE(NULLIF(NEW.quantity_reason,''),'기준 수량 등록') END,NEW.updated_by,CASE WHEN NEW.quantity_change_type='DEVICE' THEN CASE WHEN LEFT(NEW.quantity_actor,7)='DEVICE:' THEN SUBSTRING(NEW.quantity_actor,8) ELSE NEW.quantity_actor END ELSE COALESCE(NULLIF(NEW.quantity_actor,''),(SELECT login_id FROM user_profile WHERE user_id=NEW.updated_by LIMIT 1)) END,NEW.quantity_change_type,UTC_TIMESTAMP(3)+INTERVAL 9 HOUR);
  END IF;
END$$
DELIMITER ;

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
  User_customization LONGTEXT NULL,
  product_view_selection LONGTEXT NULL,
  product_control_selection LONGTEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_setting_user FOREIGN KEY (user_id) REFERENCES user_profile(user_id) ON DELETE CASCADE
) ENGINE=InnoDB;

INSERT INTO product
  (product_code, product_name, quantity, target_quantity, product_status)
VALUES
  ('P-001', '제품 A', 0, 1000, '생산중'),
  ('P-002', '제품 B', 0, 1000, '생산중'),
  ('P-003', '제품 C', 0, 1000, '대기'),
  ('P-004', '제품 D', 0, 1000, '완료'),
  ('P-005', '제품 E', 0, 1000, '정지');

-- 장치 등록·인증·접속 정보입니다. token_hash는 토큰 원본이 아닌 SHA-256 해시를 보관합니다.
CREATE TABLE device (
 device_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_code VARCHAR(100) NOT NULL,
 device_name VARCHAR(100) NOT NULL DEFAULT '', token_hash CHAR(64) NULL, token_ciphertext TEXT NULL, is_visible TINYINT(1) NOT NULL DEFAULT 1, is_enabled TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0,
 last_change_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
 last_ip VARCHAR(45) NULL, last_seen_at DATETIME(3) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(device_id), UNIQUE KEY uq_device_device_code(device_code)
) ENGINE=InnoDB;
-- 실제 16채널 상태의 기준입니다. 같은 번호의 IS/OS와 송수신 문자열을 각각 보관합니다.
CREATE TABLE device_channel (
 channel_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id VARCHAR(100) NOT NULL,
 channel_name VARCHAR(100) NOT NULL, input_signal VARCHAR(20) NOT NULL, output_signal VARCHAR(20) NOT NULL,
 is_active TINYINT(1) NOT NULL DEFAULT 1,
 web_control_enabled TINYINT(1) NOT NULL DEFAULT 1,
 web_on_enabled TINYINT(1) NOT NULL DEFAULT 1,
 web_off_enabled TINYINT(1) NOT NULL DEFAULT 1,
 web_schedule_enabled TINYINT(1) NOT NULL DEFAULT 1,
 output_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
 input_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
 last_change_source VARCHAR(100) NOT NULL DEFAULT 'BOOT', input_message TEXT NULL, output_message TEXT NULL, sort_order INT NOT NULL DEFAULT 0,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(channel_id), UNIQUE KEY uq_device_channel_input(device_id,input_signal), UNIQUE KEY uq_device_channel_output(device_id,output_signal),
 CONSTRAINT fk_device_channel_device FOREIGN KEY(device_id) REFERENCES device(device_code) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 제품코드와 디바이스 출력 채널의 연결 정의입니다. 채널이 ON으로 변경될 때 연결된 제품 수량을 1 증가시킵니다.
CREATE TABLE product_channel_mapping (
 mapping_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
 product_id INT NOT NULL,
 device_id VARCHAR(100) NOT NULL,
 output_signal VARCHAR(20) NOT NULL,
 mapping_name VARCHAR(100) NOT NULL DEFAULT '',
 is_active TINYINT(1) NOT NULL DEFAULT 1,
 created_by INT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(mapping_id),
 UNIQUE KEY uq_product_channel_mapping(product_id,device_id,output_signal),
 KEY idx_product_channel_device(device_id,output_signal),
 CONSTRAINT fk_pcm_product FOREIGN KEY(product_id) REFERENCES product(product_id) ON DELETE CASCADE,
 CONSTRAINT fk_pcm_device_channel FOREIGN KEY(device_id,output_signal) REFERENCES device_channel(device_id,output_signal) ON DELETE CASCADE,
 CONSTRAINT fk_pcm_created_by FOREIGN KEY(created_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;




-- 웹 요청과 장치 처리 상태를 기록합니다. 명령 전송 완료와 실제 출력 적용 성공은 구분합니다.
CREATE TABLE device_schedule (
  schedule_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  device_id VARCHAR(100) NOT NULL,
  output_signal VARCHAR(20) NOT NULL,
  schedule_name VARCHAR(150) NOT NULL DEFAULT '',
  action_state ENUM('ON','OFF') NOT NULL,
  ostr_payload TEXT NULL,
   repeat_type ENUM('ONCE','HOURLY','DAILY','WEEKLY','MONTHLY','YEARLY','IMMEDIATE') NOT NULL DEFAULT 'ONCE',
  schedule_time DATETIME(3) NULL,
  end_time DATETIME(3) NULL,
  weekday_mask TINYINT UNSIGNED NULL,
  is_month_end TINYINT(1) NOT NULL DEFAULT 0,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  next_run_at DATETIME(3) NULL,
  last_run_at DATETIME(3) NULL,
  last_execution_status VARCHAR(20) NOT NULL DEFAULT 'WAITING',
  last_execution_message TEXT NULL,
  created_by VARCHAR(50) NULL,
  updated_by INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (schedule_id),
  KEY idx_schedule_due (is_enabled,next_run_at),
  KEY idx_schedule_channel (device_id,output_signal),
  KEY idx_schedule_owner (created_by),
  CONSTRAINT fk_schedule_device FOREIGN KEY (device_id) REFERENCES device(device_code) ON DELETE CASCADE,
  CONSTRAINT fk_schedule_updater FOREIGN KEY (updated_by) REFERENCES user_profile(user_id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE device_command (
 command_row_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, command_id CHAR(36) NOT NULL, device_id VARCHAR(100) NOT NULL,
 output_signal VARCHAR(20) NOT NULL DEFAULT 'OS1',
 requested_output_state ENUM('ON','OFF') NOT NULL, output_message TEXT NULL, istr_payload TEXT NULL, requested_by VARCHAR(100) NOT NULL DEFAULT 'CLIENT', schedule_id BIGINT UNSIGNED NULL,
 command_status ENUM('PENDING','DELIVERED','ACKED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
 status_changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(command_row_id), UNIQUE KEY uq_device_command_id(command_id), KEY idx_device_poll(device_id,command_status,command_row_id),
 CONSTRAINT fk_device_command_device FOREIGN KEY(device_id) REFERENCES device(device_code) ON DELETE CASCADE
) ENGINE=InnoDB;
-- 출력이 바뀐 순간의 이력입니다. 당시 문자열을 복사하므로 현재 채널 문자열이 바뀌어도 유지됩니다.
CREATE TABLE device_state_history (
 history_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id VARCHAR(100) NOT NULL, output_signal VARCHAR(20) NOT NULL DEFAULT 'OS1',
 previous_output_state ENUM('ON','OFF') NULL, output_state ENUM('ON','OFF') NOT NULL, change_source VARCHAR(100) NOT NULL, schedule_id BIGINT UNSIGNED NULL,
 command_id CHAR(36) NULL,
 signal_message TEXT NULL,
 changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(history_id), KEY idx_device_history(device_id,changed_at),
 CONSTRAINT fk_device_history_device FOREIGN KEY(device_id) REFERENCES device(device_code) ON DELETE CASCADE
) ENGINE=InnoDB;
-- 예시 장치는 토큰이 없는 상태입니다. 실제 연결 전에 환경변수 또는 장치 등록으로 인증을 설정해야 합니다.
INSERT INTO device(device_code,device_name,last_change_source) VALUES('DEVICE-D1-001','DEVICE-D1-001','BOOT');

INSERT INTO device_channel(device_id,channel_name,input_signal,output_signal,sort_order) VALUES
('DEVICE-D1-001','채널 01','IS1','OS1',0),('DEVICE-D1-001','채널 02','IS2','OS2',1),('DEVICE-D1-001','채널 03','IS3','OS3',2),('DEVICE-D1-001','채널 04','IS4','OS4',3),('DEVICE-D1-001','채널 05','IS5','OS5',4),('DEVICE-D1-001','채널 06','IS6','OS6',5),('DEVICE-D1-001','채널 07','IS7','OS7',6),('DEVICE-D1-001','채널 08','IS8','OS8',7),
('DEVICE-D1-001','채널 09','IS9','OS9',8),('DEVICE-D1-001','채널 10','IS10','OS10',9),('DEVICE-D1-001','채널 11','IS11','OS11',10),('DEVICE-D1-001','채널 12','IS12','OS12',11),('DEVICE-D1-001','채널 13','IS13','OS13',12),('DEVICE-D1-001','채널 14','IS14','OS14',13),('DEVICE-D1-001','채널 15','IS15','OS15',14),('DEVICE-D1-001','채널 16','IS16','OS16',15);

-- 제품 A와 기본 디바이스 OS1의 샘플 연결입니다.
INSERT INTO product_channel_mapping (product_id,device_id,output_signal,mapping_name)
SELECT product_id,'DEVICE-D1-001','OS1','Device OS1'
FROM product WHERE product_code='P-001';
