---
name: zcode-worker
description: Giao việc cho zcode desktop (Z.ai) qua link remote trên máy người dùng. Dùng khi việc cần đúng môi trường máy đó (repo, toolchain, file đang mở). Không dùng khi chỉ cần xử lý file trong sandbox, và không tự gửi gì ra tài khoản ngoài.
---

# zcode-worker: Grok Bot điều phối, zcode desktop thực thi

## Môi trường

- zcode desktop đang chạy trên máy người dùng và đang bật Web Remote Control.
- Link dạng `https://zcode.z.ai/remote/v4?sid=…&mid=…&name=…&app_version=…` nằm trong env `ZCODE_REMOTE_URL`. Không hardcode, không dán link vào repo hoặc transcript.
- Đăng nhập giữ trong Chrome profile `~/.zcode-driver/profile` (`ZCODE_PROFILE` để đổi). `scripts/run-zcode.sh login` spawn Chrome thường (`--user-data-dir` và link, không Playwright) vì Google chặn Chrome do automation mở. Người dùng ký Z.ai cùng tài khoản desktop **và bấm chấp nhận trên app desktop**. Đóng cửa sổ sau khi thấy task list. Lệnh in `Task list is visible`, hoặc mã `login-incomplete` nếu kiểm tra headless không thấy task list. `ZCODE_JWT` là lối tắt, không bắt buộc; khi có JWT thì driver không dùng profile.
- Chrome/Chromium: `ZCODE_CHROME` nếu không nằm ở đường mặc định. Node 22+.
- Giao thức: `docs/zcode-remote-protocol.md`.

## Các bước

1. Nếu chưa login: bảo người dùng chạy `scripts/run-zcode.sh login` trên máy có màn hình (`DISPLAY` đang có). Cửa sổ là Chrome thường, không phải Chrome của Playwright. Ký cùng tài khoản, chấp nhận trên desktop, đợi task list, đóng cửa sổ. Thành công khi stderr có `Task list is visible`. `login-incomplete` nghĩa là đóng quá sớm hoặc desktop chưa chấp nhận. Không tự bịa JWT.
2. Mỗi phần việc một thư mục: `mkdir -p /tmp/work/<tên>`.
3. Viết prompt khoanh phạm vi: mục tiêu, đường dẫn trên máy người dùng, file được đụng, tiêu chí xong. Ghi rõ "Chỉ làm trong các đường dẫn đã nêu; không gửi/ghi/xoá gì lên dịch vụ ngoài; không chạy lệnh phá dữ liệu; nếu cần quyền công cụ thì dừng và hỏi".
4. Chạy task mới (không gửi vào task cũ):
   `scripts/run-zcode.sh --project <tên đúng trong Select project> /tmp/work/<tên> prompt.txt`
   Mode mặc định là Ask before changes. Đổi bằng `--mode default|edit|plan|full|autonomous` chỉ khi người dùng muốn. `--project topup` chọn đúng project tên topup. Nếu chữ đưa vào dính nhiều tên thì dừng và hỏi, đừng đoán.
5. Đọc `meta.json` (`exit`, `reason`), `final.txt`, `run.err`, `run.jsonl` (`new-task`, `project`, `mode`, `prompt-sent`, `reply`).
6. Exit 2 `auth-required`: chưa login hoặc desktop chưa chấp nhận pairing. Không gửi lại prompt. Exit 1 `project-not-found` hoặc `ambiguous-project`: sửa `--project`. `disconnected` / `failure`: desktop offline hoặc link hết hạn.
7. Sửa tiếp **cùng task vừa tạo**: `scripts/run-zcode.sh continue /tmp/work/<tên> "sửa …"`. Không thêm `--project`.
8. Dừng: `scripts/run-zcode.sh stop /tmp/work/<tên>`.
9. zcode hỏi quyền: `approvals`, rồi `approve allow` chỉ khi prompt đã cho phép đúng thao tác đó. Nghi ngờ thì `approve deny`.
10. Tự kiểm tra kết quả. Mọi thứ gửi ra ngoài vẫn qua bước duyệt của Grok Bot.

## Lưu ý

- Prompt chạy trên máy thật. Không giao việc mơ hồ.
- `run` luôn bấm New task. Đừng dùng `run` khi muốn nối task đang mở.
- Profile Chrome là phiên đăng nhập. Đừng copy profile vào repo. Cùng lúc một lệnh dùng profile; lệnh thứ hai sẽ báo profile đang bận.
- Chưa kiểm tra được cú click New task / Select project / đổi mode trên phiên đã đăng nhập. Nếu các nút đó không thấy, đọc `run.err` và dừng, đừng gửi prompt mù.
