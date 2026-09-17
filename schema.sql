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
