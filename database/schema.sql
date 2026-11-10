CREATE DATABASE IF NOT EXISTS xiaomi_watch_store
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE xiaomi_watch_store;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(24) NOT NULL,
  email VARCHAR(190) NOT NULL,
  username VARCHAR(64) NOT NULL,
  address VARCHAR(500) NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('customer', 'admin') NOT NULL DEFAULT 'customer',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_phone (phone),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(120) NOT NULL,
  description VARCHAR(500) NULL,
  UNIQUE KEY uq_categories_name (name),
  UNIQUE KEY uq_categories_slug (slug)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  category_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(180) NOT NULL,
  slug VARCHAR(200) NOT NULL,
  short_description VARCHAR(500) NOT NULL DEFAULT '',
  specifications JSON NOT NULL,
  price_vnd DECIMAL(13,0) UNSIGNED NOT NULL,
  compare_at_vnd DECIMAL(13,0) UNSIGNED NULL,
  stock INT UNSIGNED NOT NULL DEFAULT 0,
  image_url VARCHAR(500) NOT NULL DEFAULT '/assets/watch-placeholder.svg',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_products_slug (slug),
  KEY idx_products_category_active (category_id, is_active),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_code VARCHAR(32) NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  subtotal_vnd DECIMAL(13,0) UNSIGNED NOT NULL,
  shipping_fee_vnd DECIMAL(13,0) UNSIGNED NOT NULL DEFAULT 0,
  total_vnd DECIMAL(13,0) UNSIGNED NOT NULL,
  payment_method ENUM('vnpay', 'cod') NOT NULL,
  payment_status ENUM('unpaid', 'paid', 'failed', 'refunded') NOT NULL DEFAULT 'unpaid',
  order_status ENUM('pending', 'confirmed', 'packing', 'shipped', 'delivered', 'cancelled') NOT NULL DEFAULT 'pending',
  shipping_name VARCHAR(120) NOT NULL,
  shipping_phone VARCHAR(24) NOT NULL,
  shipping_address VARCHAR(500) NOT NULL,
  customer_note VARCHAR(500) NULL,
  cancellation_requested_at TIMESTAMP NULL DEFAULT NULL,
  blockchain_key CHAR(66) NULL,
  blockchain_digest CHAR(66) NULL,
  blockchain_tx_hash CHAR(66) NULL,
  blockchain_status TINYINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_orders_code (order_code),
  KEY idx_orders_user_created (user_id, created_at),
  KEY idx_orders_status_created (order_status, created_at),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NULL,
  product_name VARCHAR(180) NOT NULL,
  unit_price_vnd DECIMAL(13,0) UNSIGNED NOT NULL,
  quantity SMALLINT UNSIGNED NOT NULL,
  CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_items_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS payment_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  provider ENUM('vnpay') NOT NULL,
  transaction_ref VARCHAR(64) NOT NULL,
  response_code VARCHAR(8) NULL,
  secure_hash_valid BOOLEAN NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment_ref (transaction_ref),
  KEY idx_payment_order (order_id),
  CONSTRAINT fk_payment_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) ENGINE=InnoDB;
