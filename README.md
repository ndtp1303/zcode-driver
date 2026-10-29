# zcode-driver

Grok Bot điều phối, **zcode** (ứng dụng desktop của Z.ai) làm worker trên máy người dùng. Repo này là driver headless: gửi một việc, đọc lại file kết quả. Không phải fork của grokbot-omp; hợp đồng file đầu ra làm theo cùng kiểu.

zcode không có CLI headless cho phiên desktop. Máy tính mở một trang remote (`/remote/v4`). Link mang `sid` (phiên thiết bị) và `mid` (máy). Trang vẫn đòi đăng nhập **cùng tài khoản** với desktop rồi mới nối relay `wss://…/api/v1/remote/ws2`. Chi tiết giao thức: [docs/zcode-remote-protocol.md](docs/zcode-remote-protocol.md).

## Cài đặt

1. Node.js 22 trở lên, và Chrome hoặc Chromium (gói chỉ phụ thuộc `playwright-core`, không tự tải browser).
2. Trong repo:

   ```sh
   npm install
   ```

3. Link remote lấy từ hộp thoại Web Remote Control trên desktop. Đặt vào môi trường, không ghi vào git:

   ```sh
   export ZCODE_REMOTE_URL='https://zcode.z.ai/remote/v4?sid=…&mid=…&name=…&app_version=…'
   export ZCODE_JWT='…'          # JWT cùng tài khoản với máy tính
   # tuỳ chọn:
   # export ZCODE_PROVIDER=zai   # hoặc bigmodel
   # export ZCODE_ACCESS_TOKEN=…
   # export ZCODE_USER_INFO='{"id":"…","username":"…","displayName":"…"}'
   # export ZCODE_CHROME=/usr/bin/google-chrome
   ```

   Mẫu tên biến: `config/env.example`. JWT lấy từ localStorage khoá `zcodejwttoken` của một trình duyệt đã đăng nhập zcode, hoặc từ chính phiên đăng nhập bạn đang dùng. Link và JWT đều là bí mật.

4. Copy `skills/zcode-worker/SKILL.md` vào nơi Grok Bot đọc skill.

## Chạy

```sh
scripts/run-zcode.sh [--url URL] [--timeout GIÂY] <thư-mục> <file-prompt | "prompt">
scripts/run-zcode.sh status
scripts/run-zcode.sh list
scripts/run-zcode.sh continue <thư-mục> <file-prompt | "prompt">
scripts/run-zcode.sh stop [thư-mục]
scripts/run-zcode.sh approvals [thư-mục]
scripts/run-zcode.sh approve allow|deny [thư-mục]
```

Một lần `run` ghi trong thư mục việc:

| File | Nội dung |
| --- | --- |
| `run.jsonl` | Sự kiện: trạng thái trang, frame relay, lúc gửi prompt, lúc có trả lời |
| `final.txt` | Lời trả lời cuối của assistant |
| `run.err` | Lỗi driver |
| `meta.json` | `exit`, `seconds`, `mode`, `reason` |
| `prompt.txt` | Prompt đã định gửi |

Exit 0 = có trả lời. Exit 2 = thiếu link, chưa đăng nhập, hoặc JWT hết hạn (prompt không được gửi). Exit 1 = trang lỗi, desktop offline, hoặc hết giờ.

`status` và `list` nói chuyện JSON trực tiếp với relay (cần `ZCODE_JWT`). `run`, `continue`, `stop`, `approvals`, `approve` mở trang chính thức bằng Chrome headless vì phần hội thoại agent nằm trong khung nhị phân `rpc-frame`, không phải một message JSON. `approve` chỉ bấm **Allow** / **Deny** đúng một lần, không bấm "Always allow".

`continue` gửi thêm một prompt vào đúng cửa sổ desktop đang mở và nối thêm `run.jsonl`.

## Kiểm tra

29/10/2026, mở link remote bản desktop 3.16.3 bằng Chrome headless, profile trống: trang dừng ở **Sign In To Continue** (Connect to Z.ai / Connect to BigModel). Không có WebSocket. Relay không token trả HTTP 401. Prompt thử ("chỉ trả lời OK") không được gõ. Chưa kiểm tra được đường đã đăng nhập: pair, danh sách workspace, và một câu trả lời của agent.

## Lưu ý

- zcode chạy trên máy thật của người dùng (máy local, SSH, WSL, hoặc Docker mà desktop đã gắn). Prompt phải khoanh đúng thư mục và cấm việc không định làm.
- Cùng lúc chỉ một terminal. `status` / `list` / `run` đều chiếm chỗ; điện thoại đang mở link có thể bị ngắt.
- Tắt driver không tắt công tắc remote trên desktop.
- Mọi việc gửi ra dịch vụ ngoài (Gmail, chat, git push, …) vẫn do Grok Bot làm qua bước duyệt.

Giấy phép: MIT, xem LICENSE.
