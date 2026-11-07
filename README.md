# MiTime — cửa hàng đồng hồ Xiaomi

Đồ án web thương mại điện tử chạy trên máy cá nhân. MySQL lưu tài khoản, sản phẩm, tồn kho, đơn hàng và địa chỉ giao hàng. Hardhat tạo blockchain riêng trên máy; hợp đồng chỉ ghi mã băm đơn và trạng thái, không ghi dữ liệu cá nhân. Có thanh toán COD và cổng VNPay sandbox.

## Chức năng

- Khách xem, tìm kiếm, lọc sản phẩm; tạo tài khoản, đăng nhập, đặt hàng và xem lịch sử đơn.
- Admin tạo/sửa/ẩn sản phẩm, cập nhật trạng thái đơn và thanh toán COD.
- Admin dùng MetaMask để ghi dấu đơn hoặc trạng thái đơn lên Hardhat Local.
- Giá, hàng tồn và tổng tiền được kiểm tra lại ở máy chủ/MySQL khi tạo đơn.
- Thông tin thanh toán thử được xác minh bằng chữ ký HMAC của máy chủ. Không lưu thông tin thẻ.

## Chạy lần đầu trên Windows

1. Mở PowerShell tại thư mục `XiaomiWatchStore` và chạy các lệnh sau theo thứ tự:

   ```powershell
   .\npm-local.cmd run setup
   .\npm-local.cmd install
   .\npm-local.cmd run mysql:start
   .\npm-local.cmd run db:setup
   ```

   `setup` tạo `.env` với session secret ngẫu nhiên nếu tệp chưa có. `mysql:start` báo nếu MySQL đã chạy; nếu chưa, nó khởi động MySQL từ Wampserver. `db:setup` tự tạo database, bảng, sản phẩm mẫu và admin; không cần nhập SQL thủ công. Nếu MySQL có mật khẩu hoặc chạy cổng khác, sửa các dòng `DB_*` trong `.env`.

2. Khởi động web:

   ```powershell
   .\npm-local.cmd run dev
   ```

   Mở <http://127.0.0.1:3000>. Admin mặc định là `admin` / `Admin@123456`. Đây chỉ là tài khoản dùng trong bài làm trên máy cá nhân.

## Bật blockchain và MetaMask

1. Giữ nguyên cửa sổ web đang chạy. Mở **một cửa sổ PowerShell khác** ở thư mục dự án và chạy:

   ```powershell
   .\npm-local.cmd run chain
   ```

2. Trong cùng thư mục, mở cửa sổ PowerShell thứ ba và nhập địa chỉ ví admin đang chọn trong MetaMask:

   ```powershell
   .\npm-local.cmd run configure:wallet
   ```

   Chỉ nhập **địa chỉ công khai** bắt đầu bằng `0x`; không nhập hoặc gửi cụm khôi phục/mật khẩu/khóa riêng. Tệp địa chỉ được lưu trong `data/` và không đưa lên GitHub.

3. Triển khai hợp đồng:

   ```powershell
   .\npm-local.cmd run deploy:local
   ```

   Lệnh này cấp ETH thử nghiệm cho địa chỉ admin trên blockchain local và lưu địa chỉ hợp đồng trong tệp bị loại khỏi Git.

4. Trong MetaMask, thêm mạng thử nghiệm cục bộ: tên `LabChain Local`, RPC `http://127.0.0.1:8545`, Chain ID `31337`, ký hiệu tiền `ETH`. Mở <http://127.0.0.1:3000/admin.html>, đăng nhập tài khoản admin, chọn **Kết nối MetaMask**. Mỗi lần ghi dấu đơn, MetaMask sẽ hiện giao dịch để bạn xem và xác nhận.

Blockchain chỉ chạy khi cửa sổ Hardhat còn mở. Đây là mạng thử nghiệm cục bộ, ETH ở đây không có giá trị thật.

## VNPay sandbox

VNPay có sandbox để mô phỏng giao dịch; đây là thanh toán thử, không trừ tiền thật. Để bật phương thức này:

1. Đăng ký merchant test tại [trang đăng ký Sandbox](https://sandbox.vnpayment.vn/devreg/). VNPay gửi thông tin kết nối `TmnCode` và `HashSecret` tới email đăng ký.
2. Mở `.env` ở thư mục gốc dự án, điền hai giá trị vào `VNPAY_TMN_CODE=` và `VNPAY_HASH_SECRET=`. Không đưa `.env` lên GitHub.
3. Khởi động lại máy chủ web. Mở <http://127.0.0.1:3000/api/health>; `vnpaySandboxConfigured` cần là `true`. Nếu chưa có thông tin merchant, khách vẫn đặt đơn bằng COD.
4. Khi VNPay Sandbox hiển thị trang thẻ, dùng thẻ test NCB trong [hướng dẫn chính thức](https://sandbox.vnpayment.vn/apis/docs/gioi-thieu/).

Tài liệu tích hợp thanh toán: [VNPay Pay API](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html). Trang trả kết quả thanh toán có thể trở lại `127.0.0.1` trên cùng máy. IPN server-to-server từ VNPay không truy cập được localhost; muốn trình diễn IPN cần một URL HTTPS công khai/tunnel và đăng ký endpoint `/api/payments/vnpay/ipn` trong cấu hình merchant VNPay.

Thông số bốn sản phẩm mẫu được đối chiếu từ các trang Xiaomi: [Watch S4](https://www.mi.com/ae-en/product/xiaomi-watch-s4/specs/), [Watch 2](https://www.mi.com/global/product/xiaomi-watch-2/), [Redmi Watch 5](https://www.mi.com/ph/product/redmi-watch-5/specs/) và [Smart Band 9 Pro](https://www.mi.com/uk/product/xiaomi-smart-band-9-pro/specs/). Thời lượng pin là mức công bố theo điều kiện thử nghiệm của hãng.

## GitHub

Có thể đưa mã nguồn lên GitHub sau khi hoàn thành. `.env`, mật khẩu, cấu hình ví, khóa triển khai, database và địa chỉ hợp đồng local đều nằm trong `.gitignore`. Chỉ đưa mã nguồn, schema, dữ liệu mẫu và hướng dẫn lên repository.
