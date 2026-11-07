# MiTime — cửa hàng đồng hồ Xiaomi

Đồ án web thương mại điện tử chạy trên máy cá nhân. MySQL lưu tài khoản, sản phẩm, tồn kho, đơn hàng và địa chỉ giao hàng. Hardhat tạo blockchain riêng trên máy; hợp đồng chỉ ghi mã băm đơn và trạng thái, không ghi dữ liệu cá nhân. Có thanh toán COD và cổng VNPay sandbox.

## Chức năng

- Khách xem, tìm kiếm, lọc sản phẩm; tạo tài khoản, đăng nhập, đặt hàng và xem lịch sử đơn.
- Admin tạo/sửa/ẩn sản phẩm, cập nhật trạng thái đơn và thanh toán COD.
- Admin dùng MetaMask để ghi dấu đơn hoặc trạng thái đơn lên Hardhat Local.
- Giá, hàng tồn và tổng tiền được kiểm tra lại ở máy chủ/MySQL khi tạo đơn.
- Thông tin thanh toán thử được xác minh bằng chữ ký HMAC của máy chủ. Không lưu thông tin thẻ.

## Chạy lần đầu trên Windows

1. Mở Wampserver, chờ biểu tượng chuyển xanh. Mở phpMyAdmin và đăng nhập MySQL.
2. Trong phpMyAdmin, chọn **Import** và nhập `database/schema.sql`, sau đó nhập `database/seed.sql`. Đây là schema mới cho dự án này; không nhập vào database LabChain.
3. Mở PowerShell tại thư mục `XiaomiWatchStore` và chạy:

   ```powershell
   .\npm-local.cmd run setup
   .\npm-local.cmd install
   .\npm-local.cmd run db:seed
   ```

   `setup` tạo `.env` với session secret ngẫu nhiên nếu tệp chưa có. Trong thư mục làm việc hiện tại, `.env` đã được tạo sẵn. Nếu MySQL có mật khẩu hoặc chạy cổng khác, sửa các dòng `DB_*` trong `.env`.

4. Khởi động web:

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

VNPay có sandbox để mô phỏng giao dịch. Để máy chủ tạo URL thanh toán có chữ ký, cần `TmnCode` và `HashSecret` do VNPay cấp; điền hai giá trị này vào `.env`. Khi chưa có, khách vẫn có thể đặt bằng COD. Thông tin đăng ký và luồng thanh toán nằm trong [tài liệu sandbox chính thức](https://sandbox.vnpayment.vn/apis/docs/gioi-thieu/) và [tài liệu thanh toán](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html).

Trang trả kết quả thanh toán có thể trở lại `127.0.0.1` trên cùng máy. IPN server-to-server từ VNPay không truy cập được localhost; muốn trình diễn IPN cần một URL HTTPS công khai/tunnel và đăng ký endpoint `/api/payments/vnpay/ipn` trong cấu hình merchant VNPay.

## GitHub

Có thể đưa mã nguồn lên GitHub sau khi hoàn thành. `.env`, mật khẩu, cấu hình ví, khóa triển khai, database và địa chỉ hợp đồng local đều nằm trong `.gitignore`. Chỉ đưa mã nguồn, schema, dữ liệu mẫu và hướng dẫn lên repository.
