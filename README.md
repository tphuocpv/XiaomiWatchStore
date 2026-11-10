# MiTime Watch Store

MiTime là ứng dụng thương mại điện tử dành cho đồng hồ thông minh Xiaomi và Redmi, gồm cửa hàng cho khách hàng và bảng điều khiển quản trị. MySQL quản lý tài khoản, danh mục, sản phẩm, tồn kho và đơn hàng. Hợp đồng Solidity lưu mã băm cùng trạng thái đơn hàng trên blockchain thử nghiệm; thông tin cá nhân được giữ trong MySQL. Thanh toán hỗ trợ COD và VNPay Sandbox.

## Tính năng

- Khách hàng tìm kiếm, lọc sản phẩm, tạo tài khoản, đăng nhập, đặt hàng, theo dõi đơn và hủy đơn chưa thanh toán trước khi giao hàng.
- Khách hàng có thể tiếp tục thanh toán VNPay nếu giao dịch chưa hoàn tất.
- Quản trị viên quản lý khách hàng, danh mục, sản phẩm, tồn kho, trạng thái đơn và thanh toán COD.
- MetaMask xác nhận giao dịch ghi bằng chứng đơn hàng lên blockchain.
- Máy chủ kiểm tra giá và tồn kho trước khi tạo đơn; hệ thống không lưu thông tin thẻ.
- Giao diện và thông báo lỗi bằng tiếng Việt.

## Công nghệ

- Node.js, Express và MySQL
- Solidity, Hardhat Network và MetaMask
- VNPay Sandbox cho luồng thanh toán thử nghiệm

## Cài đặt trên Windows

Yêu cầu Node.js 22 trở lên và MySQL. Các lệnh sau chạy trong PowerShell tại thư mục dự án:

```powershell
.\npm-local.cmd run setup
.\npm-local.cmd install
.\npm-local.cmd run mysql:start
.\npm-local.cmd run db:setup
.\npm-local.cmd run dev
```

Mở <http://127.0.0.1:3000> để truy cập cửa hàng. Nếu MySQL dùng cổng hoặc mật khẩu khác, cập nhật các biến `DB_*` trong `.env`.

Tài khoản quản trị mặc định: `admin` / `Admin@123456`. Có thể đặt tên đăng nhập và mật khẩu khác trong `.env` trước khi khởi tạo database. Tài khoản đã tạo sẽ giữ nguyên mật khẩu hiện có. Thông tin mặc định chỉ dành cho môi trường trình diễn cục bộ.

## Blockchain và MetaMask

Blockchain dùng Hardhat Network chạy trên máy cục bộ, không phải Ethereum Mainnet. Mạng này phục vụ trình diễn; ETH thử nghiệm không có giá trị thực.

1. Mở cửa sổ PowerShell khác và chạy:

   ```powershell
   .\npm-local.cmd run chain
   ```

2. Mở cửa sổ PowerShell thứ ba, sau đó nhập địa chỉ công khai của ví quản trị:

   ```powershell
   .\npm-local.cmd run configure:wallet
   ```

   Chỉ nhập địa chỉ bắt đầu bằng `0x`. Không nhập cụm khôi phục, mật khẩu hoặc khóa riêng. Cấu hình được lưu trong `data/`, thư mục này không được đưa lên Git.

3. Triển khai hợp đồng:

   ```powershell
   .\npm-local.cmd run deploy:local
   ```

4. Thêm mạng **LabChain Local** vào MetaMask với RPC `http://127.0.0.1:8545`, Chain ID `31337` và ký hiệu tiền tệ `ETH`. Đăng nhập quản trị tại <http://127.0.0.1:3000/admin.html>, kết nối MetaMask và xác nhận giao dịch khi được yêu cầu.

Giữ cửa sổ Hardhat mở trong khi trình diễn. Hợp đồng chỉ lưu mã băm đơn hàng và trạng thái, không lưu tên, địa chỉ hoặc số điện thoại khách hàng.

## Thanh toán VNPay

VNPay Sandbox dùng giao dịch mô phỏng và không thu tiền thật. Để bật phương thức này:

1. Đăng ký merchant thử nghiệm tại [VNPay Sandbox](https://sandbox.vnpayment.vn/devreg/). VNPay gửi `TmnCode` và `HashSecret` tới email đăng ký.
2. Điền hai giá trị vào `VNPAY_TMN_CODE` và `VNPAY_HASH_SECRET` trong `.env`. Không chia sẻ tệp `.env`.
3. Khởi động lại máy chủ. Nếu chưa cấu hình merchant, khách hàng vẫn có thể chọn COD.
4. Dùng thẻ thử nghiệm được nêu trong [tài liệu VNPay Sandbox](https://sandbox.vnpayment.vn/apis/docs/gioi-thieu/).

Tài liệu tích hợp: [VNPay Pay API](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html). Trang trả kết quả có thể trở lại máy cục bộ; IPN từ VNPay không thể gọi trực tiếp tới `localhost`. Muốn trình diễn IPN cần một URL HTTPS công khai và cấu hình endpoint `/api/payments/vnpay/ipn` trong merchant.

## Danh mục và hình ảnh

Database được khởi tạo với bốn sản phẩm mẫu để trình diễn luồng mua hàng. Quản trị viên có thể sửa nội dung và giá trong bảng điều khiển. Thông số sản phẩm được đối chiếu từ trang Xiaomi: [Watch S4](https://www.mi.com/ae-en/product/xiaomi-watch-s4/specs/), [Watch 2](https://www.mi.com/global/product/xiaomi-watch-2/), [Redmi Watch 5](https://www.mi.com/ph/product/redmi-watch-5/specs/) và [Smart Band 9 Pro](https://www.mi.com/uk/product/xiaomi-smart-band-9-pro/). Ảnh trong `public/assets` được lấy từ CDN hiển thị trên các trang sản phẩm Xiaomi; quyền hình ảnh thuộc Xiaomi. Thời lượng pin là số liệu hãng công bố trong điều kiện thử nghiệm.

## Repository

Mã nguồn: [github.com/tphuocpv/XiaomiWatchStore](https://github.com/tphuocpv/XiaomiWatchStore). Tệp `.env`, database, cấu hình ví và địa chỉ hợp đồng cục bộ được loại khỏi repository bằng `.gitignore`.
