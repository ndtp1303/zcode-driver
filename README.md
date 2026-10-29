# zcode-driver

Grok Bot điều phối, **zcode** (ứng dụng desktop của Z.ai) làm worker trên máy người dùng. Repo này là driver headless: gửi một việc, đọc lại file kết quả. Không phải fork của grokbot-omp; hợp đồng file đầu ra làm theo cùng kiểu.

zcode không có CLI headless cho phiên desktop. Máy tính mở một trang remote (`/remote/v4`). Link mang `sid` (phiên thiết bị) và `mid` (máy). Trang vẫn đòi đăng nhập **cùng tài khoản** với desktop rồi mới nối relay `wss://…/api/v1/remote/ws2`. Chi tiết giao thức: [docs/zcode-remote-protocol.md](docs/zcode-remote-protocol.md).

## Cài đặt

1. Node.js 22 trở lên, và Chrome hoặc Chromium. Gói chỉ phụ thuộc `playwright-core`, không tự tải browser. Trên Linux đặt `ZCODE_CHROME` nếu binary không nằm ở `/usr/bin/google-chrome` hoặc `/usr/bin/chromium`.
2. Trong repo: `npm install`
3. Link remote lấy từ hộp thoại Web Remote Control trên desktop. Không ghi vào git:

   ```sh
   export ZCODE_REMOTE_URL='https://zcode.z.ai/remote/v4?sid=…&mid=…&name=…&app_version=…'
   # tuỳ chọn, máy Linux:
   # export ZCODE_CHROME=/usr/bin/google-chrome
   # export ZCODE_PROFILE=$HOME/.zcode-driver/profile
   ```

4. Đăng nhập một lần, trên máy có màn hình (cùng user sẽ chạy các lệnh sau):

   ```sh
   scripts/run-zcode.sh login
   ```

   Chrome hiện cửa sổ, profile mặc định `~/.zcode-driver/profile`. Đăng nhập **cùng tài khoản** với desktop (Z.ai qua Google được). Sau khi vào trang, app desktop hỏi chấp nhận trình duyệt này: phải bấm đồng ý trên desktop thì danh sách task mới hiện. Thấy task list thì đóng Chrome. Các lệnh sau mở lại đúng profile đó ở chế độ headless.

5. `ZCODE_JWT` vẫn dùng được nếu không muốn profile. Khi JWT có giá trị, driver không đụng profile mà nhét token vào một Chrome tạm. Mẫu biến: `config/env.example`.
6. Copy `skills/zcode-worker/SKILL.md` vào nơi Grok Bot đọc skill.

## Chạy

```sh
scripts/run-zcode.sh login
scripts/run-zcode.sh [--project TÊN] [--mode ask] [--timeout GIÂY] <thư-mục> <file-prompt | "prompt">
scripts/run-zcode.sh status
scripts/run-zcode.sh list
scripts/run-zcode.sh continue <thư-mục> <file-prompt | "prompt">
scripts/run-zcode.sh stop [thư-mục]
scripts/run-zcode.sh approvals [thư-mục]
scripts/run-zcode.sh approve allow|deny [thư-mục]
```

`run` bấm **New task**, rồi chọn project trong menu Select project (`--project`). Tên khớp đúng thì thắng (`topup` ra `topup`). Một mẩu tên dính nhiều project (`top` với `topup` và `topup_netease`) thì dừng, không đoán. Mode mặc định `--mode ask` là **Ask before changes**. Mode khác: `default`, `edit`, `plan`, `full`, `autonomous`. `continue` gửi thêm vào task đang mở, không tạo task mới và không nhận `--project` / `--mode`.

Không có JWT thì `status` / `list` cũng đọc trang bằng profile (tên máy, project, task). Có JWT thì hai lệnh đó gọi relay JSON như trước.

Một lần `run` ghi trong thư mục việc:

| File | Nội dung |
| --- | --- |
| `run.jsonl` | Sự kiện: trạng thái trang, frame relay, lúc gửi prompt, lúc có trả lời |
| `final.txt` | Lời trả lời cuối của assistant |
| `run.err` | Lỗi driver |
| `meta.json` | `exit`, `seconds`, `mode`, `reason` |
| `prompt.txt` | Prompt đã định gửi |

Exit 0 = có trả lời. Exit 2 = thiếu link, chưa đăng nhập, hoặc chưa được desktop chấp nhận (prompt không được gửi). Exit 1 = trang lỗi, desktop offline, project không khớp, hoặc hết giờ.

`run` / `continue` / `stop` / `approvals` mở trang chính thức bằng Chrome vì hội thoại agent nằm trong khung nhị phân `rpc-frame`. `approve` chỉ bấm **Allow** / **Deny** đúng một lần, không bấm "Always allow".

## Kiểm tra

29/10/2026, profile trống: trang dừng ở **Sign In To Continue**. Prompt thử không được gõ. Relay không token trả HTTP 401.

Người dùng đã đăng nhập Z.ai (Google) trên Chrome thường và được desktop chấp nhận. Trang khi đó hiện máy `MacBook-Pro-cua-SUSU.local`, New task, Automations, Plugin Marketplace, task theo project, composer Select project, mode Ask before changes. Driver **chưa** được chạy trên phiên đã đăng nhập đó: bấm New task, chọn project, đổi mode, và một câu trả lời của agent vẫn chưa kiểm tra. Các nút lấy từ bundle 3.16.3 (`task-new-button`, `composer-workspace-trigger`, `data-project-name`, `chat-mode-select-item-build`).

## Lưu ý

- zcode chạy trên máy thật của người dùng (máy local, SSH, WSL, hoặc Docker mà desktop đã gắn). Prompt phải khoanh đúng thư mục và cấm việc không định làm.
- Cùng lúc chỉ một terminal. `status` / `list` / `run` đều chiếm chỗ; điện thoại đang mở link có thể bị ngắt.
- Tắt driver không tắt công tắc remote trên desktop.
- Mọi việc gửi ra dịch vụ ngoài (Gmail, chat, git push, …) vẫn do Grok Bot làm qua bước duyệt.

Giấy phép: MIT, xem LICENSE.
