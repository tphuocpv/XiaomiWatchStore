# Phân chia công việc Xiaomi Watch Store

Hai người làm trên hai nhánh riêng rồi tạo Pull Request vào `main`. Không cùng sửa một nhóm tệp.

## Thành viên 1 — Chủ repo: API và MySQL

Nhánh: `feat/crypto-payment-api`

- `server/index.js`, `server/crypto-payments.js`: tạo báo giá ETH và kiểm chứng transaction receipt/log trước khi cập nhật MySQL.
- `database/schema.sql`, `scripts/initialize-database.js`: lưu báo giá, ví khách, mã giao dịch trả/hoàn tiền và trạng thái blockchain.
- Xử lý tạo đơn, thanh toán lại, cập nhật trạng thái giao hàng, hoàn tiền và hủy đơn.

## Thành viên 2 — Cộng tác viên: hợp đồng và MetaMask

Nhánh: `feat/crypto-wallet-ui`

- `contracts/OrderEscrow.sol`, `scripts/deploy-local.js`: escrow, khóa hoàn tiền khi chuyển sang giao hàng, giải ngân sau khi giao, hoàn tiền khi hủy.
- `public/app.js`, `public/index.html`, `public/app.css`: chọn ETH thử nghiệm, thanh toán MetaMask và thanh toán lại trong “Đơn hàng của tôi”.
- `public/admin.js`, `public/admin.html`, `public/admin.css`: MetaMask admin đánh dấu đang giao, giải ngân, hoàn tiền.

## Giao ước tích hợp

- Mạng local: Chain ID `31337`; ETH chỉ dùng để demo.
- `OrderEscrow.payOrder(bytes32 orderKey, bytes32 invoiceHash, uint256 expectedAmount, uint256 deadline, bytes signature)` nhận đúng `msg.value` và yêu cầu chữ ký báo giá do máy chủ ký.
- `POST /api/orders/:id/payments/crypto/confirm` chỉ xác nhận sau khi máy chủ đọc receipt thành công và event `PaymentEscrowed` khớp đơn.
- Admin gọi `markShipped(orderKey)` trước khi API đổi đơn sang `shipped`; `releaseOrder(orderKey)` trước khi đổi sang `delivered`; `refundOrder(orderKey)` trước khi duyệt hủy đơn đã thanh toán; `cancelUnpaidOrder(orderKey)` trước khi duyệt hủy đơn chưa thanh toán.
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
