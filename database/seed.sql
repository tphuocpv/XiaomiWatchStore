USE `xiaomi_watch_store`;

INSERT INTO danh_muc (ten, ten_duong_dan, mo_ta) VALUES
  ('Đồng hồ Xiaomi', 'dong-ho-xiaomi', 'Các mẫu Xiaomi Watch'),
  ('Đồng hồ Redmi', 'dong-ho-redmi', 'Các mẫu Redmi Watch'),
  ('Vòng đeo thông minh', 'vong-deo-thong-minh', 'Vòng đeo theo dõi sức khỏe')
ON DUPLICATE KEY UPDATE mo_ta = danh_muc.mo_ta;

INSERT INTO san_pham
  (ma_danh_muc, ten, ten_duong_dan, mo_ta_ngan, thong_so, gia_vnd, gia_niem_yet_vnd, ton_kho, duong_dan_anh)
SELECT c.ma, p.ten, p.ten_duong_dan, p.mo_ta_ngan, p.thong_so, p.gia_vnd, p.gia_niem_yet_vnd, p.ton_kho, p.duong_dan_anh
FROM danh_muc c
JOIN (
  SELECT 'Xiaomi Watch S4' ten, 'xiaomi-watch-s4' ten_duong_dan,
         'AMOLED 1,43 inch · GNSS tích hợp · Pin tới 15 ngày' mo_ta_ngan,
         '{"Màn hình":"AMOLED 1,43 inch, 466 × 466 px, tối đa 1500 nit HBM","Định vị":"GNSS 5 hệ thống","Pin và kháng nước":"486 mAh, tới 15 ngày, 5ATM"}' thong_so,
         3990000 gia_vnd, 4490000 gia_niem_yet_vnd, 12 ton_kho, '/assets/xiaomi-watch-s4.jpg' duong_dan_anh, 'dong-ho-xiaomi' duong_dan_danh_muc
  UNION ALL
  SELECT 'Xiaomi Watch 2', 'xiaomi-watch-2', 'Wear OS by Google · Snapdragon W5+ Gen 1 · Pin tới 65 giờ',
         '{"Màn hình":"AMOLED 1,43 inch, 466 × 466 px","Nền tảng":"Snapdragon W5+ Gen 1, Wear OS by Google","Pin và kháng nước":"495 mAh, tới 65 giờ, 5ATM"}',
         4490000, 4990000, 8, '/assets/xiaomi-watch-2.jpg', 'dong-ho-xiaomi'
  UNION ALL
  SELECT 'Redmi Watch 5', 'redmi-watch-5', 'AMOLED 2,07 inch · GNSS tích hợp · Pin tới 24 ngày',
         '{"Màn hình":"AMOLED 2,07 inch, 432 × 514 px, tối đa 1500 nit","Định vị":"GNSS 5 hệ thống","Pin và kháng nước":"550 mAh, tới 24 ngày, 5ATM"}',
         1790000, 1990000, 20, '/assets/redmi-watch-5.jpg', 'dong-ho-redmi'
  UNION ALL
  SELECT 'Xiaomi Smart Band 9 Pro', 'xiaomi-smart-band-9-pro', 'AMOLED 1,74 inch · GNSS tích hợp · Pin tới 21 ngày',
         '{"Màn hình":"AMOLED 1,74 inch, 336 × 480 px","Định vị":"GNSS 5 hệ thống","Pin và kháng nước":"Tới 21 ngày, 5ATM"}',
         1590000, 1890000, 18, '/assets/smart-band-9-pro.png', 'vong-deo-thong-minh'
) p ON p.duong_dan_danh_muc = c.ten_duong_dan
WHERE NOT EXISTS (SELECT 1 FROM san_pham existing WHERE existing.ten_duong_dan = p.ten_duong_dan);

-- Chỉ cập nhật dữ liệu mẫu ban đầu, giữ các thay đổi của quản trị viên.
UPDATE san_pham
SET mo_ta_ngan = 'AMOLED 1,43 inch · GNSS tích hợp · Pin tới 15 ngày',
    thong_so = JSON_OBJECT('Màn hình', 'AMOLED 1,43 inch, 466 × 466 px, tối đa 1500 nit HBM', 'Định vị', 'GNSS 5 hệ thống', 'Pin và kháng nước', '486 mAh, tới 15 ngày, 5ATM')
WHERE ten_duong_dan = 'xiaomi-watch-s4' AND JSON_UNQUOTE(JSON_EXTRACT(thong_so, '$.battery')) = 'Thông số minh họa';
UPDATE san_pham
SET mo_ta_ngan = 'Wear OS by Google · Snapdragon W5+ Gen 1 · Pin tới 65 giờ',
    thong_so = JSON_OBJECT('Màn hình', 'AMOLED 1,43 inch, 466 × 466 px', 'Nền tảng', 'Snapdragon W5+ Gen 1, Wear OS by Google', 'Pin và kháng nước', '495 mAh, tới 65 giờ, 5ATM')
WHERE ten_duong_dan = 'xiaomi-watch-2' AND JSON_UNQUOTE(JSON_EXTRACT(thong_so, '$.battery')) = 'Thông số minh họa';
UPDATE san_pham
SET mo_ta_ngan = 'AMOLED 2,07 inch · GNSS tích hợp · Pin tới 24 ngày',
    thong_so = JSON_OBJECT('Màn hình', 'AMOLED 2,07 inch, 432 × 514 px, tối đa 1500 nit', 'Định vị', 'GNSS 5 hệ thống', 'Pin và kháng nước', '550 mAh, tới 24 ngày, 5ATM')
WHERE ten_duong_dan = 'redmi-watch-5' AND JSON_UNQUOTE(JSON_EXTRACT(thong_so, '$.battery')) = 'Thông số minh họa';
UPDATE san_pham
SET mo_ta_ngan = 'AMOLED 1,74 inch · GNSS tích hợp · Pin tới 21 ngày',
    thong_so = JSON_OBJECT('Màn hình', 'AMOLED 1,74 inch, 336 × 480 px', 'Định vị', 'GNSS 5 hệ thống', 'Pin và kháng nước', 'Tới 21 ngày, 5ATM')
WHERE ten_duong_dan = 'xiaomi-smart-band-9-pro' AND JSON_UNQUOTE(JSON_EXTRACT(thong_so, '$.battery')) = 'Thông số minh họa';

UPDATE san_pham SET duong_dan_anh = '/assets/xiaomi-watch-s4.jpg' WHERE ten_duong_dan = 'xiaomi-watch-s4' AND duong_dan_anh IN ('/assets/watch-s4.svg', '/assets/watch-placeholder.svg');
UPDATE san_pham SET duong_dan_anh = '/assets/xiaomi-watch-2.jpg' WHERE ten_duong_dan = 'xiaomi-watch-2' AND duong_dan_anh IN ('/assets/watch-2.svg', '/assets/watch-placeholder.svg');
UPDATE san_pham SET duong_dan_anh = '/assets/redmi-watch-5.jpg' WHERE ten_duong_dan = 'redmi-watch-5' AND duong_dan_anh IN ('/assets/redmi-watch-5.svg', '/assets/watch-placeholder.svg');
UPDATE san_pham SET duong_dan_anh = '/assets/smart-band-9-pro.png' WHERE ten_duong_dan = 'xiaomi-smart-band-9-pro' AND duong_dan_anh IN ('/assets/smart-band-9-pro.svg', '/assets/watch-placeholder.svg');
