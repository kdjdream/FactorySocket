CREATE DATABASE IF NOT EXISTS factory
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE factory;

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100) NOT NULL,
  region VARCHAR(100) NOT NULL,
  company VARCHAR(150) NOT NULL,
  position VARCHAR(100) NOT NULL,
  phone VARCHAR(20) NOT NULL,
  email VARCHAR(254) NOT NULL,
  role ENUM('USER','MASTER') NOT NULL DEFAULT 'USER',
  permission_level TINYINT UNSIGNED NOT NULL DEFAULT 1,
  admin_memo TEXT NULL,
  user_request_at DATETIME NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
  approved_at DATETIME NULL,
  approved_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_approved_by FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_status (status),
  KEY idx_users_permission_level (permission_level),
  KEY idx_users_created_at (created_at)
);

CREATE TABLE IF NOT EXISTS products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  product_code VARCHAR(50) NOT NULL UNIQUE,
  product_name VARCHAR(100) NOT NULL,
  quantity INT NOT NULL DEFAULT 0,
  target_quantity INT NOT NULL DEFAULT 100,
  status VARCHAR(20) NOT NULL DEFAULT '대기',
  active TINYINT(1) NOT NULL DEFAULT 1,
  updated_by INT NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_products_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS user_settings (
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
  date_format VARCHAR(10) NOT NULL DEFAULT 'ko-KR',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_user_settings_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO products
  (product_code, product_name, quantity, target_quantity, status)
VALUES
  ('P-001', '제품 A', 120, 500, '생산중'),
  ('P-002', '제품 B', 250, 500, '생산중'),
  ('P-003', '제품 C', 80, 300, '대기'),
  ('P-004', '제품 D', 420, 500, '완료'),
  ('P-005', '제품 E', 65, 200, '정지')
ON DUPLICATE KEY UPDATE
  product_code = VALUES(product_code);

-- Wemos D1 R1 D9 램프 기능: 기존 factory DB에 추가
CREATE TABLE IF NOT EXISTS wemos_devices (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id VARCHAR(100) NOT NULL,
 device_name VARCHAR(100) NOT NULL DEFAULT '', token_hash CHAR(64) NULL, active TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0,
 current_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
 d8_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF', d7_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
 d10_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF', d11_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
 last_source VARCHAR(100) NOT NULL DEFAULT 'BOOT', d8_source VARCHAR(100) NOT NULL DEFAULT 'BOOT', d7_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
 d10_source VARCHAR(100) NOT NULL DEFAULT 'BOOT', d11_source VARCHAR(100) NOT NULL DEFAULT 'BOOT',
 last_seen_at DATETIME(3) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(id), UNIQUE KEY uq_wemos_device_id(device_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS wemos_contact_sets (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id VARCHAR(100) NOT NULL,
 set_name VARCHAR(100) NOT NULL, input_pin VARCHAR(20) NOT NULL, output_pin VARCHAR(20) NOT NULL,
 active TINYINT(1) NOT NULL DEFAULT 1, current_state ENUM('ON','OFF') NOT NULL DEFAULT 'OFF',
 last_source VARCHAR(100) NOT NULL DEFAULT 'BOOT', input_string TEXT NULL, output_string TEXT NULL, sort_order INT NOT NULL DEFAULT 0,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
 PRIMARY KEY(id), UNIQUE KEY uq_contact_input(device_id,input_pin), UNIQUE KEY uq_contact_output(device_id,output_pin),
 CONSTRAINT fk_contact_device FOREIGN KEY(device_id) REFERENCES wemos_devices(device_id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS wemos_device_commands (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, command_id CHAR(36) NOT NULL, device_id VARCHAR(100) NOT NULL,
 pin_name VARCHAR(20) NOT NULL DEFAULT 'OS1',
 desired_state ENUM('ON','OFF') NOT NULL, requester VARCHAR(100) NOT NULL DEFAULT 'CLIENT',
 status ENUM('PENDING','DELIVERED','ACKED','FAILED','CANCELLED') NOT NULL DEFAULT 'PENDING',
 changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(id), UNIQUE KEY uq_wemos_command_id(command_id), KEY idx_wemos_poll(device_id,status,id),
 CONSTRAINT fk_wemos_command_device FOREIGN KEY(device_id) REFERENCES wemos_devices(device_id) ON DELETE CASCADE
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS wemos_lamp_state_history (
 id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, device_id VARCHAR(100) NOT NULL, pin_name VARCHAR(20) NOT NULL DEFAULT 'OS1',
 previous_state ENUM('ON','OFF') NULL, new_state ENUM('ON','OFF') NOT NULL, source VARCHAR(100) NOT NULL,
 command_id CHAR(36) NULL, changed_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 PRIMARY KEY(id), KEY idx_wemos_history(device_id,changed_at),
 CONSTRAINT fk_wemos_history_device FOREIGN KEY(device_id) REFERENCES wemos_devices(device_id) ON DELETE CASCADE
) ENGINE=InnoDB;
INSERT INTO wemos_devices(device_id,device_name,current_state,last_source) VALUES('WEMOS-D1-001','WEMOS-D1-001','OFF','BOOT')
ON DUPLICATE KEY UPDATE device_name=VALUES(device_name);

INSERT IGNORE INTO wemos_contact_sets(device_id,set_name,input_pin,output_pin,sort_order) VALUES
('WEMOS-D1-001','채널 01','IS1','OS1',0),('WEMOS-D1-001','채널 02','IS2','OS2',1),('WEMOS-D1-001','채널 03','IS3','OS3',2),('WEMOS-D1-001','채널 04','IS4','OS4',3),('WEMOS-D1-001','채널 05','IS5','OS5',4),('WEMOS-D1-001','채널 06','IS6','OS6',5),('WEMOS-D1-001','채널 07','IS7','OS7',6),('WEMOS-D1-001','채널 08','IS8','OS8',7);
