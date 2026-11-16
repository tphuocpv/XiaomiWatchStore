CREATE DATABASE IF NOT EXISTS `xiaomi_watch_store`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `xiaomi_watch_store`;

CREATE TABLE IF NOT EXISTS nguoi_dung (
  ma BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ho_ten VARCHAR(120) NOT NULL,
  so_dien_thoai VARCHAR(24) NOT NULL,
  thu_dien_tu VARCHAR(190) NOT NULL,
  ten_dang_nhap VARCHAR(64) NOT NULL,
  dia_chi VARCHAR(500) NULL,
  mat_khau_bam VARCHAR(255) NOT NULL,
  vai_tro ENUM('customer', 'admin') NOT NULL DEFAULT 'customer',
  tao_luc TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY duy_nhat_so_dien_thoai (so_dien_thoai),
  UNIQUE KEY duy_nhat_thu_dien_tu (thu_dien_tu),
  UNIQUE KEY duy_nhat_ten_dang_nhap (ten_dang_nhap)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS danh_muc (
  ma BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ten VARCHAR(100) NOT NULL,
  ten_duong_dan VARCHAR(120) NOT NULL,
  mo_ta VARCHAR(500) NULL,
  UNIQUE KEY duy_nhat_ten_danh_muc (ten),
  UNIQUE KEY duy_nhat_duong_dan_danh_muc (ten_duong_dan)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS san_pham (
  ma BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ma_danh_muc BIGINT UNSIGNED NOT NULL,
  ten VARCHAR(180) NOT NULL,
  ten_duong_dan VARCHAR(200) NOT NULL,
  mo_ta_ngan VARCHAR(500) NOT NULL DEFAULT '',
  thong_so JSON NOT NULL,
  gia_vnd DECIMAL(13,0) UNSIGNED NOT NULL,
  gia_niem_yet_vnd DECIMAL(13,0) UNSIGNED NULL,
  ton_kho INT UNSIGNED NOT NULL DEFAULT 0,
  duong_dan_anh VARCHAR(500) NOT NULL DEFAULT '/assets/watch-placeholder.svg',
  dang_hoat_dong BOOLEAN NOT NULL DEFAULT TRUE,
  tao_luc TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cap_nhat_luc TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY duy_nhat_duong_dan_san_pham (ten_duong_dan),
  KEY chi_muc_danh_muc_hoat_dong (ma_danh_muc, dang_hoat_dong),
  CONSTRAINT khoa_ngoai_san_pham_danh_muc FOREIGN KEY (ma_danh_muc) REFERENCES danh_muc(ma)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS don_hang (
  ma BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ma_don VARCHAR(32) NOT NULL,
  ma_nguoi_dung BIGINT UNSIGNED NOT NULL,
  tam_tinh_vnd DECIMAL(13,0) UNSIGNED NOT NULL,
  phi_giao_hang_vnd DECIMAL(13,0) UNSIGNED NOT NULL DEFAULT 0,
  tong_tien_vnd DECIMAL(13,0) UNSIGNED NOT NULL,
  phuong_thuc_thanh_toan ENUM('vnpay', 'cod', 'crypto') NOT NULL,
  trang_thai_thanh_toan ENUM('unpaid', 'paid', 'failed', 'refunded') NOT NULL DEFAULT 'unpaid',
  trang_thai_don ENUM('pending', 'confirmed', 'packing', 'shipped', 'delivered', 'cancelled') NOT NULL DEFAULT 'pending',
  ten_nguoi_nhan VARCHAR(120) NOT NULL,
  so_dien_thoai_nhan VARCHAR(24) NOT NULL,
  dia_chi_nhan VARCHAR(500) NOT NULL,
  ghi_chu_khach VARCHAR(500) NULL,
  yeu_cau_huy_luc TIMESTAMP NULL DEFAULT NULL,
  khoa_don_blockchain CHAR(66) NULL,
  ma_bam_hoa_don CHAR(66) NULL,
  ma_giao_dich_blockchain CHAR(66) NULL,
  trang_thai_blockchain TINYINT UNSIGNED NULL,
  tao_luc TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cap_nhat_luc TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY duy_nhat_ma_don (ma_don),
  KEY chi_muc_nguoi_dung_tao_luc (ma_nguoi_dung, tao_luc),
  KEY chi_muc_trang_thai_tao_luc (trang_thai_don, tao_luc),
  CONSTRAINT khoa_ngoai_don_hang_nguoi_dung FOREIGN KEY (ma_nguoi_dung) REFERENCES nguoi_dung(ma)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS chi_tiet_don_hang (
  ma BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ma_don_hang BIGINT UNSIGNED NOT NULL,
  ma_san_pham BIGINT UNSIGNED NULL,
  ten_san_pham VARCHAR(180) NOT NULL,
  don_gia_vnd DECIMAL(13,0) UNSIGNED NOT NULL,
  so_luong SMALLINT UNSIGNED NOT NULL,
  CONSTRAINT khoa_ngoai_chi_tiet_don_hang FOREIGN KEY (ma_don_hang) REFERENCES don_hang(ma) ON DELETE CASCADE,
  CONSTRAINT khoa_ngoai_chi_tiet_san_pham FOREIGN KEY (ma_san_pham) REFERENCES san_pham(ma) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS lan_thanh_toan (
  ma BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ma_don_hang BIGINT UNSIGNED NOT NULL,
  nha_cung_cap ENUM('vnpay') NOT NULL,
  ma_tham_chieu VARCHAR(64) NOT NULL,
  ma_phan_hoi VARCHAR(8) NULL,
  chu_ky_hop_le BOOLEAN NULL,
  tao_luc TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY duy_nhat_ma_tham_chieu (ma_tham_chieu),
  KEY chi_muc_thanh_toan_ma_don (ma_don_hang),
  CONSTRAINT khoa_ngoai_lan_thanh_toan_don_hang FOREIGN KEY (ma_don_hang) REFERENCES don_hang(ma) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Chỉ lưu thông tin phục vụ đối chiếu khoản ETH thử nghiệm; không lưu dữ liệu giao hàng trên blockchain.
CREATE TABLE IF NOT EXISTS thanh_toan_eth (
  ma_don_hang BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  ma_mang BIGINT UNSIGNED NOT NULL DEFAULT 31337,
  so_tien_wei VARCHAR(78) NOT NULL,
  dia_chi_vi_khach CHAR(42) NULL,
  ma_giao_dich_thanh_toan CHAR(66) NULL,
  ma_giao_dich_giao_hang CHAR(66) NULL,
  ma_giao_dich_giai_ngan CHAR(66) NULL,
  ma_giao_dich_hoan_tien CHAR(66) NULL,
  ma_giao_dich_huy CHAR(66) NULL,
  trang_thai ENUM('unpaid', 'escrowed', 'shipped', 'released', 'refunded', 'cancelled') NOT NULL DEFAULT 'unpaid',
  tao_luc TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  cap_nhat_luc TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY duy_nhat_giao_dich_thanh_toan (ma_giao_dich_thanh_toan),
  UNIQUE KEY duy_nhat_giao_dich_giao_hang (ma_giao_dich_giao_hang),
  UNIQUE KEY duy_nhat_giao_dich_giai_ngan (ma_giao_dich_giai_ngan),
  UNIQUE KEY duy_nhat_giao_dich_hoan_tien (ma_giao_dich_hoan_tien),
  UNIQUE KEY duy_nhat_giao_dich_huy (ma_giao_dich_huy),
  CONSTRAINT khoa_ngoai_thanh_toan_eth_don_hang FOREIGN KEY (ma_don_hang) REFERENCES don_hang(ma) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS tac_vu_blockchain (
  ma BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ma_don_hang BIGINT UNSIGNED NOT NULL,
  trang_thai_don TINYINT UNSIGNED NOT NULL,
  ma_giao_dich CHAR(66) NULL,
  ma_phien_so_cai CHAR(66) NULL,
  thu_lai_luc TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  so_lan_thu SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  UNIQUE KEY duy_nhat_tac_vu_trang_thai (ma_don_hang, trang_thai_don),
  KEY chi_muc_tac_vu_thu_lai (ma_giao_dich, thu_lai_luc, ma),
  CONSTRAINT khoa_ngoai_tac_vu_don_hang FOREIGN KEY (ma_don_hang) REFERENCES don_hang(ma) ON DELETE CASCADE
) ENGINE=InnoDB;
