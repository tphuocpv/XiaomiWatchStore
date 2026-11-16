const tableNames = {
  users: "nguoi_dung",
  categories: "danh_muc",
  products: "san_pham",
  orders: "don_hang",
  order_items: "chi_tiet_don_hang",
  payment_attempts: "lan_thanh_toan",
  crypto_payments: "thanh_toan_eth",
  blockchain_order_jobs: "tac_vu_blockchain",
};

const columnNames = {
  id: "ma",
  full_name: "ho_ten",
  phone: "so_dien_thoai",
  email: "thu_dien_tu",
  username: "ten_dang_nhap",
  address: "dia_chi",
  password_hash: "mat_khau_bam",
  role: "vai_tro",
  created_at: "tao_luc",
  updated_at: "cap_nhat_luc",
  name: "ten",
  slug: "ten_duong_dan",
  description: "mo_ta",
  category_id: "ma_danh_muc",
  short_description: "mo_ta_ngan",
  specifications: "thong_so",
  price_vnd: "gia_vnd",
  compare_at_vnd: "gia_niem_yet_vnd",
  stock: "ton_kho",
  image_url: "duong_dan_anh",
  is_active: "dang_hoat_dong",
  order_code: "ma_don",
  user_id: "ma_nguoi_dung",
  subtotal_vnd: "tam_tinh_vnd",
  shipping_fee_vnd: "phi_giao_hang_vnd",
  total_vnd: "tong_tien_vnd",
  payment_method: "phuong_thuc_thanh_toan",
  payment_status: "trang_thai_thanh_toan",
  order_status: "trang_thai_don",
  shipping_name: "ten_nguoi_nhan",
  shipping_phone: "so_dien_thoai_nhan",
  shipping_address: "dia_chi_nhan",
  customer_note: "ghi_chu_khach",
  cancellation_requested_at: "yeu_cau_huy_luc",
  blockchain_key: "khoa_don_blockchain",
  blockchain_digest: "ma_bam_hoa_don",
  blockchain_tx_hash: "ma_giao_dich_blockchain",
  blockchain_status: "trang_thai_blockchain",
  order_id: "ma_don_hang",
  product_id: "ma_san_pham",
  product_name: "ten_san_pham",
  unit_price_vnd: "don_gia_vnd",
  quantity: "so_luong",
  provider: "nha_cung_cap",
  transaction_ref: "ma_tham_chieu",
  response_code: "ma_phan_hoi",
  secure_hash_valid: "chu_ky_hop_le",
  chain_id: "ma_mang",
  amount_wei: "so_tien_wei",
  buyer_address: "dia_chi_vi_khach",
  payment_tx_hash: "ma_giao_dich_thanh_toan",
  ship_tx_hash: "ma_giao_dich_giao_hang",
  release_tx_hash: "ma_giao_dich_giai_ngan",
  refund_tx_hash: "ma_giao_dich_hoan_tien",
  cancel_tx_hash: "ma_giao_dich_huy",
  status: "trang_thai",
  tx_hash: "ma_giao_dich",
  registry_epoch: "ma_phien_so_cai",
  retry_at: "thu_lai_luc",
  attempts: "so_lan_thu",
};

const foreignKeyNames = {
  fk_products_category: "khoa_ngoai_san_pham_danh_muc",
  fk_orders_user: "khoa_ngoai_don_hang_nguoi_dung",
  fk_order_items_order: "khoa_ngoai_chi_tiet_don_hang",
  fk_order_items_product: "khoa_ngoai_chi_tiet_san_pham",
  fk_payment_order: "khoa_ngoai_lan_thanh_toan_don_hang",
  fk_crypto_payment_order: "khoa_ngoai_thanh_toan_eth_don_hang",
  fk_chain_job_order: "khoa_ngoai_tac_vu_don_hang",
};

const indexNames = {
  uq_users_phone: "duy_nhat_so_dien_thoai",
  uq_users_email: "duy_nhat_thu_dien_tu",
  uq_users_username: "duy_nhat_ten_dang_nhap",
  uq_categories_name: "duy_nhat_ten_danh_muc",
  uq_categories_slug: "duy_nhat_duong_dan_danh_muc",
  uq_products_slug: "duy_nhat_duong_dan_san_pham",
  idx_products_category_active: "chi_muc_danh_muc_hoat_dong",
  uq_orders_code: "duy_nhat_ma_don",
  idx_orders_user_created: "chi_muc_nguoi_dung_tao_luc",
  idx_orders_status_created: "chi_muc_trang_thai_tao_luc",
  uq_payment_ref: "duy_nhat_ma_tham_chieu",
  idx_payment_order: "chi_muc_thanh_toan_ma_don",
  uq_crypto_payment_tx: "duy_nhat_giao_dich_thanh_toan",
  uq_crypto_ship_tx: "duy_nhat_giao_dich_giao_hang",
  uq_crypto_release_tx: "duy_nhat_giao_dich_giai_ngan",
  uq_crypto_refund_tx: "duy_nhat_giao_dich_hoan_tien",
  uq_crypto_cancel_tx: "duy_nhat_giao_dich_huy",
  uq_chain_job_status: "duy_nhat_tac_vu_trang_thai",
  idx_chain_job_retry: "chi_muc_tac_vu_thu_lai",
  ...foreignKeyNames,
};

function pendingRenames(existingNames, nameMap, scope) {
  const existing = new Set(existingNames);
  return Object.entries(nameMap).filter(([oldName, newName]) => {
    if (!existing.has(oldName)) return false;
    if (existing.has(newName)) {
      throw new Error(`Có cả tên cũ “${oldName}” và tên mới “${newName}” trong ${scope}.`);
    }
    return true;
  });
}

async function renameForeignKeys(connection, quotedTable, createTable, renames) {
  if (renames.length === 0) return;
  const definitions = createTable.split(/\r?\n/).map((line) => line.trim().replace(/,$/, ""));
  const clauses = renames.flatMap(([oldName, newName]) => {
    const oldIdentifier = connection.escapeId(oldName);
    const newIdentifier = connection.escapeId(newName);
    const prefix = `CONSTRAINT ${oldIdentifier} FOREIGN KEY `;
    const definition = definitions.find((line) => line.startsWith(prefix));
    if (!definition) throw new Error(`Không tìm thấy định nghĩa khóa ngoại ${oldName}.`);
    return [
      `DROP FOREIGN KEY ${oldIdentifier}`,
      `ADD ${definition.replace(prefix, `CONSTRAINT ${newIdentifier} FOREIGN KEY `)}`,
    ];
  });

  // MySQL yêu cầu tắt kiểm tra trong phiên DDL để thay tên khóa trong một ALTER nguyên tử.
  // Định nghĩa được giữ nguyên, các phiên khác tiếp tục kiểm tra khóa ngoại bình thường.
  await connection.query("SET SESSION foreign_key_checks = 0");
  try {
    await connection.query(`ALTER TABLE ${quotedTable} ${clauses.join(", ")}, ALGORITHM=INPLACE`);
  } finally {
    await connection.query("SET SESSION foreign_key_checks = 1");
  }
}

export async function translateDatabaseIdentifiers(connection, databaseName) {
  const [tables] = await connection.execute(
    `SELECT TABLE_NAME AS name FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`,
    [databaseName],
  );
  const existingNames = tables.map(({ name }) => name);
  const tableRenames = pendingRenames(existingNames, tableNames, databaseName);
  const localizedTables = Object.values(tableNames)
    .filter((table) => existingNames.includes(table) || tableRenames.some(([, newName]) => newName === table));
  if (localizedTables.length === 0) return;

  await connection.query("USE ??", [databaseName]);
  if (tableRenames.length) {
    const clauses = tableRenames.map(([oldName, newName]) =>
      `${connection.escapeId(oldName)} TO ${connection.escapeId(newName)}`);
    await connection.query(`RENAME TABLE ${clauses.join(", ")}`);
  }

  for (const table of localizedTables) {
    const [columnRows] = await connection.query("SHOW COLUMNS FROM ??", [table]);
    const [indexRows] = await connection.query("SHOW INDEX FROM ??", [table]);
    const columns = pendingRenames(columnRows.map(({ Field }) => Field), columnNames, table);
    const indexes = pendingRenames(indexRows.map(({ Key_name }) => Key_name), indexNames, table);
    const quotedTable = connection.escapeId(table);
    const clauses = [
      ...columns.map(([oldName, newName]) =>
        `RENAME COLUMN ${connection.escapeId(oldName)} TO ${connection.escapeId(newName)}`),
      ...indexes.map(([oldName, newName]) =>
        `RENAME INDEX ${connection.escapeId(oldName)} TO ${connection.escapeId(newName)}`),
    ];
    if (clauses.length) {
      await connection.query(`ALTER TABLE ${quotedTable} ${clauses.join(", ")}, ALGORITHM=INPLACE`);
    }
    const [definitions] = await connection.query("SHOW CREATE TABLE ??", [table]);
    const createTable = definitions[0]["Create Table"];
    const foreignKeys = [...createTable.matchAll(/^\s*CONSTRAINT `([^`]+)` FOREIGN KEY /gm)]
      .map(([, name]) => name);
    await renameForeignKeys(connection, quotedTable, createTable, pendingRenames(foreignKeys, foreignKeyNames, table));
  }
}
