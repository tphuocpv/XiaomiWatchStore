# MiTime Watch Store

MiTime là ứng dụng thương mại điện tử dành cho đồng hồ thông minh Xiaomi và Redmi, gồm cửa hàng cho khách hàng và bảng điều khiển quản trị. MySQL quản lý tài khoản, danh mục, sản phẩm, tồn kho và đơn hàng. Hợp đồng Solidity lưu bằng chứng đơn hàng và giữ ETH thử nghiệm trong escrow; thông tin cá nhân được giữ trong MySQL. Thanh toán hỗ trợ COD, VNPay Sandbox và ETH trên Hardhat Local.

## Tính năng

- Khách hàng tìm kiếm, lọc sản phẩm, tạo tài khoản, đăng nhập, đặt hàng và gửi yêu cầu hủy trước khi đơn chuyển sang giao hàng.
- Quản trị viên duyệt hoặc từ chối yêu cầu hủy; đơn đã thanh toán cần được hoàn tiền trước khi duyệt.
- Khách hàng có thể tiếp tục thanh toán VNPay nếu giao dịch chưa hoàn tất.
- Mỗi đơn chỉ có một phiên VNPay đang mở; nút thanh toán lại xuất hiện sau khi phiên cũ kết thúc hoặc hết hạn.
- Admin chờ phiên VNPay hết hạn trước khi duyệt hủy đơn chưa thanh toán, tránh nhận tiền sau khi hủy.
- Nếu VNPay xác nhận tiền sau khi đơn đã hủy, trang quản trị báo cần đối soát; admin hoàn giao dịch trên VNPay Sandbox rồi ghi nhận kết quả trong MiTime.
- Khách hàng có thể thanh toán bằng ETH thử nghiệm qua MetaMask; hợp đồng giữ khoản tiền đến khi đơn giao thành công.
- Khi đơn bị hủy trước lúc giao, hợp đồng hoàn ETH cho khách; khi chuyển sang đang giao, hợp đồng khóa khả năng hoàn tiền.
- MiTime tự gửi giao dịch giải ngân khi admin lưu trạng thái Đã giao và tự hoàn ETH khi admin duyệt hủy.
- SweetAlert2 hiển thị hộp thoại xác nhận và thông báo trạng thái cho các thao tác quan trọng.
- Quản trị viên quản lý khách hàng, danh mục, sản phẩm, tồn kho, trạng thái đơn và thanh toán COD.
- Máy chủ tự ghi mã băm và trạng thái đơn lên blockchain. Các bản ghi chờ sẽ được gửi lại khi Hardhat sẵn sàng.
- Máy chủ kiểm tra giá và tồn kho trước khi tạo đơn; hệ thống không lưu thông tin thẻ.
- Giao diện và thông báo lỗi bằng tiếng Việt.

## Công nghệ

- Node.js, Express và MySQL
- Solidity, Hardhat Network và MetaMask
- VNPay Sandbox cho luồng thanh toán thử nghiệm
- SweetAlert2 cho hộp thoại xác nhận, thông báo và toast

## Cài đặt trên Windows

Yêu cầu Node.js 22 trở lên và MySQL. Các lệnh sau chạy trong PowerShell tại thư mục dự án:

```powershell
.\npm-local.cmd install
.\npm-local.cmd run setup
.\npm-local.cmd run mysql:start
.\npm-local.cmd run db:setup
.\npm-local.cmd run dev
```

Mở <http://127.0.0.1:3000> để truy cập cửa hàng. Nếu MySQL dùng cổng hoặc mật khẩu khác, cập nhật các biến `DB_*` trong `.env`.

Để nâng cấp cơ sở dữ liệu đã cài, dừng máy chủ web, chạy lại `.\npm-local.cmd run db:setup` rồi mở lại web. Lệnh này đổi tên bảng, cột và khóa của MiTime sang tiếng Việt không dấu, đồng thời giữ dữ liệu hiện có. `DB_NAME` trong `.env` cho phép chọn tên cơ sở dữ liệu, mặc định là `xiaomi_watch_store`.

Tài khoản quản trị mặc định: `admin` / `Admin@123456`. Có thể đặt tên đăng nhập và mật khẩu khác trong `.env` trước khi khởi tạo database. Tài khoản đã tạo sẽ giữ nguyên mật khẩu hiện có. Thông tin mặc định chỉ dành cho môi trường trình diễn cục bộ.

## Blockchain và MetaMask

Blockchain dùng Hardhat Network chạy trên máy cục bộ, không phải Ethereum Mainnet. Mạng này phục vụ trình diễn; ETH thử nghiệm không có giá trị thực. Tỷ giá quy đổi từ VND sang ETH được cố định cục bộ trong `CRYPTO_ETH_VND_RATE` của `.env` (mặc định 1 ETH = 100.000.000 ₫).

1. Mở cửa sổ PowerShell khác và chạy:

   ```powershell
   .\npm-local.cmd run chain
   ```

2. Mở cửa sổ PowerShell thứ ba. Nếu cần chỉ định ví nhận tiền của cửa hàng, chạy lệnh sau rồi nhập địa chỉ công khai của ví. Mặc định, hợp đồng dùng tài khoản đầu tiên của Hardhat làm ví nhận tiền.

   ```powershell
   .\npm-local.cmd run configure:wallet
   ```

   Chỉ nhập địa chỉ bắt đầu bằng `0x`. Không nhập cụm khôi phục, mật khẩu hoặc khóa riêng. Cấu hình được lưu trong `data/`, thư mục này không được đưa lên Git.

3. Triển khai hợp đồng:

   ```powershell
   .\npm-local.cmd run deploy:local
   ```

4. Khởi động lại web nếu vừa chạy `setup` trong lúc web đang mở. Khi khách chọn **Ví MetaMask (ETH)**, trang mở yêu cầu thanh toán ngay sau khi đặt hàng. Lần đầu, khách có thể cần cho phép kết nối và chọn mạng **LabChain Local** với RPC `http://127.0.0.1:8545`, Chain ID `31337` và ký hiệu `ETH`. Khách xác nhận khoản chi trong MetaMask.
5. Admin thao tác đơn như bình thường tại <http://127.0.0.1:3000/admin.html>. Ví dịch vụ đã được Hardhat cấp ETH thử nghiệm để ký giao dịch và trả phí. Khoản giải ngân đi tới ví nhận tiền của cửa hàng.

Chọn **Tra cứu mã giao dịch** trong trang quản trị hoặc mở mã giao dịch trên một đơn để xem chi tiết trực tiếp từ Hardhat. Trang cho biết số ETH thực chuyển, địa chỉ gửi và nhận tiền, block và phí gas.

Giữ cửa sổ Hardhat mở trong khi trình diễn. Khóa ví tự động và khóa ký báo giá được `setup` tạo trong `.env`. Ví tự động chỉ hoạt động trên Hardhat cục bộ. Khi nâng cấp hợp đồng đang giữ ETH, hãy xử lý xong các đơn đó trên hợp đồng cũ trước khi triển khai lại. Hợp đồng chỉ lưu mã băm đơn hàng/hóa đơn, ví thanh toán, số ETH thử nghiệm và trạng thái escrow. Tên, địa chỉ và số điện thoại khách hàng được giữ trong MySQL.

## Chia việc cho hai thành viên

Xem [docs/PHAN_CHIA_CONG_VIEC.md](docs/PHAN_CHIA_CONG_VIEC.md) để biết phạm vi tệp, giao ước API/hợp đồng và cách phối hợp qua nhánh GitHub.

## Thanh toán VNPay

VNPay Sandbox dùng giao dịch mô phỏng và không thu tiền thật. Để bật phương thức này:

1. Đăng ký merchant thử nghiệm tại [VNPay Sandbox](https://sandbox.vnpayment.vn/devreg/). VNPay gửi `TmnCode` và `HashSecret` tới email đăng ký.
2. Điền hai giá trị vào `VNPAY_TMN_CODE` và `VNPAY_HASH_SECRET` trong `.env`. Không chia sẻ tệp `.env`.
3. Khởi động lại máy chủ. Nếu chưa cấu hình merchant, khách hàng vẫn có thể chọn COD.
4. Dùng thẻ thử nghiệm được nêu trong [tài liệu VNPay Sandbox](https://sandbox.vnpayment.vn/apis/docs/gioi-thieu/).

Kết quả thanh toán đến muộn sau khi đơn bị hủy được hiển thị riêng cho khách và admin. Bản demo yêu cầu admin xử lý hoàn tiền trong cổng VNPay Sandbox trước khi xác nhận trạng thái hoàn tiền trong trang quản trị.

Tài liệu tích hợp: [VNPay Pay API](https://sandbox.vnpayment.vn/apis/docs/thanh-toan-pay/pay.html). Trang trả kết quả có thể trở lại máy cục bộ; IPN từ VNPay không thể gọi trực tiếp tới `localhost`. Muốn trình diễn IPN cần một URL HTTPS công khai và cấu hình endpoint `/api/payments/vnpay/ipn` trong merchant.

## Danh mục và hình ảnh

Database được khởi tạo với bốn sản phẩm mẫu để trình diễn luồng mua hàng. Quản trị viên có thể sửa nội dung và giá trong bảng điều khiển. Thông số sản phẩm được đối chiếu từ trang Xiaomi: [Watch S4](https://www.mi.com/ae-en/product/xiaomi-watch-s4/specs/), [Watch 2](https://www.mi.com/global/product/xiaomi-watch-2/), [Redmi Watch 5](https://www.mi.com/ph/product/redmi-watch-5/specs/) và [Smart Band 9 Pro](https://www.mi.com/uk/product/xiaomi-smart-band-9-pro/). Ảnh trong `public/assets` được lấy từ CDN hiển thị trên các trang sản phẩm Xiaomi; quyền hình ảnh thuộc Xiaomi. Thời lượng pin là số liệu hãng công bố trong điều kiện thử nghiệm.

## Repository

Mã nguồn: [github.com/tphuocpv/XiaomiWatchStore](https://github.com/tphuocpv/XiaomiWatchStore). Tệp `.env`, database, cấu hình ví và địa chỉ hợp đồng cục bộ được loại khỏi repository bằng `.gitignore`.
