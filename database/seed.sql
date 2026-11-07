USE xiaomi_watch_store;

INSERT INTO categories (name, slug, description) VALUES
  ('Đồng hồ Xiaomi', 'dong-ho-xiaomi', 'Các mẫu Xiaomi Watch'),
  ('Đồng hồ Redmi', 'dong-ho-redmi', 'Các mẫu Redmi Watch'),
  ('Vòng đeo thông minh', 'vong-deo-thong-minh', 'Vòng đeo theo dõi sức khỏe')
ON DUPLICATE KEY UPDATE description = VALUES(description);

INSERT INTO products
  (category_id, name, slug, short_description, specifications, price_vnd, compare_at_vnd, stock, image_url)
SELECT c.id, p.name, p.slug, p.short_description, p.specifications, p.price_vnd, p.compare_at_vnd, p.stock, '/assets/watch-placeholder.svg'
FROM categories c
JOIN (
  SELECT 'Xiaomi Watch S4' name, 'xiaomi-watch-s4' slug,
         'Màn hình AMOLED · GPS · Thời lượng pin dài' short_description,
         '{"display":"AMOLED","gps":"Tích hợp","battery":"Thông số minh họa"}' specifications,
         3990000 price_vnd, 4490000 compare_at_vnd, 12 stock, 'dong-ho-xiaomi' category_slug
  UNION ALL
  SELECT 'Xiaomi Watch 2', 'xiaomi-watch-2', 'Thiết kế thể thao · Theo dõi vận động',
         '{"display":"AMOLED","gps":"Tích hợp","battery":"Thông số minh họa"}',
         4490000, 4990000, 8, 'dong-ho-xiaomi'
  UNION ALL
  SELECT 'Redmi Watch 5', 'redmi-watch-5', 'Màn hình lớn · Nhiều chế độ luyện tập',
         '{"display":"AMOLED","gps":"Tùy phiên bản","battery":"Thông số minh họa"}',
         1790000, 1990000, 20, 'dong-ho-redmi'
  UNION ALL
  SELECT 'Xiaomi Smart Band 9 Pro', 'xiaomi-smart-band-9-pro', 'Nhẹ gọn · Theo dõi sức khỏe hằng ngày',
         '{"display":"AMOLED","gps":"Tích hợp","battery":"Thông số minh họa"}',
         1590000, 1890000, 18, 'vong-deo-thong-minh'
) p ON p.category_slug = c.slug
WHERE NOT EXISTS (SELECT 1 FROM products existing WHERE existing.slug = p.slug);
