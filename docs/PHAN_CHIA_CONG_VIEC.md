# Phân chia công việc Xiaomi Watch Store

Hai người làm trên hai nhánh riêng rồi tạo Pull Request vào `main`. Không cùng sửa một nhóm tệp.

## Thành viên 1 — Chủ repo: API và MySQL

Nhánh: `feat/crypto-payment-api`

- `server/index.js`, `server/crypto-payments.js`, `server/blockchain-automation.js`: tạo báo giá ETH, xác minh giao dịch và tự ghi trạng thái đơn.
- `database/schema.sql`, `scripts/initialize-database.js`: lưu báo giá, ví khách, mã giao dịch trả/hoàn tiền và trạng thái blockchain.
- Xử lý tạo đơn, thanh toán lại, cập nhật trạng thái giao hàng, hoàn tiền và hủy đơn.

## Thành viên 2 — Cộng tác viên: hợp đồng và MetaMask

Nhánh: `feat/crypto-wallet-ui`

- `contracts/OrderEscrow.sol`, `scripts/deploy-local.js`: escrow, khóa hoàn tiền khi chuyển sang giao hàng, giải ngân sau khi giao, hoàn tiền khi hủy.
- `public/app.js`, `public/index.html`, `public/app.css`: chọn ETH thử nghiệm, thanh toán MetaMask và thanh toán lại trong “Đơn hàng của tôi”.
- `public/admin.js`, `public/admin.html`, `public/admin.css`: hiển thị đồng bộ blockchain và giao dịch quản trị do máy chủ gửi.

## Giao ước tích hợp

- Mạng local: Chain ID `31337`; ETH chỉ dùng để demo.
- `OrderEscrow.payOrder(bytes32 orderKey, bytes32 invoiceHash, uint256 expectedAmount, uint256 deadline, bytes signature)` nhận đúng `msg.value` và yêu cầu chữ ký báo giá do máy chủ ký.
- `POST /api/orders/:id/payments/crypto/confirm` chỉ xác nhận sau khi máy chủ đọc receipt thành công và event `PaymentEscrowed` khớp đơn.
- Máy chủ tự gọi `markShipped` hoặc `releaseOrder` khi admin cập nhật giao hàng. Khi duyệt hủy, máy chủ tự gọi `refundOrder` cho khoản đã thanh toán hoặc `cancelUnpaidOrder` để khóa thanh toán cho đơn chưa trả tiền.
- Backend chỉ chấp nhận giao dịch admin do `deployment.admin` ký và giao dịch khách khớp ví ghi trong event thanh toán.
- Không đưa thông tin cá nhân, địa chỉ giao hàng, khóa riêng, seed phrase hoặc `.env` lên blockchain/GitHub.

## Quy trình Git

Mỗi người cập nhật `main`, sau đó tạo nhánh riêng:

```powershell
git switch main
git pull origin main
git switch -c feat/ten-cong-viec
```

Sau khi làm xong:

```powershell
git add duong-dan-tep-da-sua
git commit -m "Mo ta ngan gon thay doi"
git push -u origin feat/ten-cong-viec
```

Tạo Pull Request vào `main`; người còn lại xem thay đổi rồi mới gộp. Không commit `.env`, `data`, `node_modules`, `artifacts`, `cache` hay `public/deployment.json`.
