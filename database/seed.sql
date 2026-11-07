USE xiaomi_watch_store;

INSERT INTO categories (name, slug, description) VALUES
  ('Đồng hồ Xiaomi', 'dong-ho-xiaomi', 'Các mẫu Xiaomi Watch'),
  ('Đồng hồ Redmi', 'dong-ho-redmi', 'Các mẫu Redmi Watch'),
  ('Vòng đeo thông minh', 'vong-deo-thong-minh', 'Vòng đeo theo dõi sức khỏe')
ON DUPLICATE KEY UPDATE description = VALUES(description);

INSERT INTO products
  (category_id, name, slug, short_description, specifications, price_vnd, compare_at_vnd, stock, image_url)
SELECT c.id, p.name, p.slug, p.short_description, p.specifications, p.price_vnd, p.compare_at_vnd, p.stock, p.image_url
FROM categories c
JOIN (
  SELECT 'Xiaomi Watch S4' name, 'xiaomi-watch-s4' slug,
         'AMOLED 1,43 inch · GNSS tích hợp · Pin tới 15 ngày' short_description,
         '{"Màn hình":"AMOLED 1,43 inch, 466 × 466 px, tối đa 1500 nit HBM","Định vị":"GNSS 5 hệ thống","Pin và kháng nước":"486 mAh, tới 15 ngày, 5ATM"}' specifications,
         3990000 price_vnd, 4490000 compare_at_vnd, 12 stock, '/assets/watch-s4.svg' image_url, 'dong-ho-xiaomi' category_slug
  UNION ALL
  SELECT 'Xiaomi Watch 2', 'xiaomi-watch-2', 'Wear OS by Google · Snapdragon W5+ Gen 1 · Pin tới 65 giờ',
         '{"Màn hình":"AMOLED 1,43 inch, 466 × 466 px","Nền tảng":"Snapdragon W5+ Gen 1, Wear OS by Google","Pin và kháng nước":"495 mAh, tới 65 giờ, 5ATM"}',
         4490000, 4990000, 8, '/assets/watch-2.svg', 'dong-ho-xiaomi'
  UNION ALL
  SELECT 'Redmi Watch 5', 'redmi-watch-5', 'AMOLED 2,07 inch · GNSS tích hợp · Pin tới 24 ngày',
         '{"Màn hình":"AMOLED 2,07 inch, 432 × 514 px, tối đa 1500 nit","Định vị":"GNSS 5 hệ thống","Pin và kháng nước":"550 mAh, tới 24 ngày, 5ATM"}',
         1790000, 1990000, 20, '/assets/redmi-watch-5.svg', 'dong-ho-redmi'
  UNION ALL
  SELECT 'Xiaomi Smart Band 9 Pro', 'xiaomi-smart-band-9-pro', 'AMOLED 1,74 inch · GNSS tích hợp · Pin tới 21 ngày',
         '{"Màn hình":"AMOLED 1,74 inch, 336 × 480 px","Định vị":"GNSS 5 hệ thống","Pin và kháng nước":"Tới 21 ngày, 5ATM"}',
         1590000, 1890000, 18, '/assets/smart-band-9-pro.svg', 'vong-deo-thong-minh'
) p ON p.category_slug = c.slug
WHERE NOT EXISTS (SELECT 1 FROM products existing WHERE existing.slug = p.slug);

-- Migrate only the original placeholder records; preserve later admin edits.
UPDATE products
SET short_description = 'AMOLED 1,43 inch · GNSS tích hợp · Pin tới 15 ngày',
    specifications = JSON_OBJECT('Màn hình', 'AMOLED 1,43 inch, 466 × 466 px, tối đa 1500 nit HBM', 'Định vị', 'GNSS 5 hệ thống', 'Pin và kháng nước', '486 mAh, tới 15 ngày, 5ATM')
WHERE slug = 'xiaomi-watch-s4' AND JSON_UNQUOTE(JSON_EXTRACT(specifications, '$.battery')) = 'Thông số minh họa';
UPDATE products
SET short_description = 'Wear OS by Google · Snapdragon W5+ Gen 1 · Pin tới 65 giờ',
    specifications = JSON_OBJECT('Màn hình', 'AMOLED 1,43 inch, 466 × 466 px', 'Nền tảng', 'Snapdragon W5+ Gen 1, Wear OS by Google', 'Pin và kháng nước', '495 mAh, tới 65 giờ, 5ATM')
WHERE slug = 'xiaomi-watch-2' AND JSON_UNQUOTE(JSON_EXTRACT(specifications, '$.battery')) = 'Thông số minh họa';
UPDATE products
SET short_description = 'AMOLED 2,07 inch · GNSS tích hợp · Pin tới 24 ngày',
    specifications = JSON_OBJECT('Màn hình', 'AMOLED 2,07 inch, 432 × 514 px, tối đa 1500 nit', 'Định vị', 'GNSS 5 hệ thống', 'Pin và kháng nước', '550 mAh, tới 24 ngày, 5ATM')
WHERE slug = 'redmi-watch-5' AND JSON_UNQUOTE(JSON_EXTRACT(specifications, '$.battery')) = 'Thông số minh họa';
UPDATE products
SET short_description = 'AMOLED 1,74 inch · GNSS tích hợp · Pin tới 21 ngày',
    specifications = JSON_OBJECT('Màn hình', 'AMOLED 1,74 inch, 336 × 480 px', 'Định vị', 'GNSS 5 hệ thống', 'Pin và kháng nước', 'Tới 21 ngày, 5ATM')
WHERE slug = 'xiaomi-smart-band-9-pro' AND JSON_UNQUOTE(JSON_EXTRACT(specifications, '$.battery')) = 'Thông số minh họa';

UPDATE products SET image_url = '/assets/watch-s4.svg' WHERE slug = 'xiaomi-watch-s4';
UPDATE products SET image_url = '/assets/watch-2.svg' WHERE slug = 'xiaomi-watch-2';
UPDATE products SET image_url = '/assets/redmi-watch-5.svg' WHERE slug = 'redmi-watch-5';
UPDATE products SET image_url = '/assets/smart-band-9-pro.svg' WHERE slug = 'xiaomi-smart-band-9-pro';
