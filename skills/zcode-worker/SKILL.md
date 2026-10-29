---
name: zcode-worker
description: Giao việc cho zcode desktop (Z.ai) qua link remote trên máy người dùng. Dùng khi việc cần đúng môi trường máy đó (repo, toolchain, file đang mở). Không dùng khi chỉ cần xử lý file trong sandbox, và không tự gửi gì ra tài khoản ngoài.
---

# zcode-worker: Grok Bot điều phối, zcode desktop thực thi

## Môi trường

- zcode desktop đang chạy trên máy người dùng và đang bật Web Remote Control.
- Link dạng `https://zcode.z.ai/remote/v4?sid=…&mid=…&name=…&app_version=…` nằm trong env `ZCODE_REMOTE_URL`. Không hardcode, không dán link vào repo hoặc transcript.
- `ZCODE_JWT` là JWT cùng tài khoản với desktop (localStorage `zcodejwttoken`). Không in ra.
- Driver: `scripts/run-zcode.sh` trong repo zcode-driver. Node 22+ và Chrome/Chromium (`ZCODE_CHROME` nếu binary không nằm ở đường mặc định).
- Giao thức (relay ws2, vì sao prompt đi qua trang): `docs/zcode-remote-protocol.md`.

## Các bước

1. Mỗi phần việc một thư mục: `mkdir -p /tmp/work/<tên>`, chép file đầu vào nếu có.
2. Viết prompt khoanh phạm vi: mục tiêu, đường dẫn trên máy người dùng, file được đụng, tiêu chí xong. Ghi rõ "Chỉ làm trong các đường dẫn đã nêu; không gửi/ghi/xoá gì lên dịch vụ ngoài; không chạy lệnh phá dữ liệu; nếu cần quyền công cụ thì dừng và hỏi".
3. Chạy:
   `scripts/run-zcode.sh /tmp/work/<tên> prompt.txt`
   Việc dài: thêm `--timeout <giây>`. Không chạy nhiều việc song song lên cùng một link: relay chỉ giữ một terminal, việc sau đá việc trước.
4. Đọc `meta.json` (`exit`, `reason`), `final.txt`, `run.err`, và `run.jsonl` (sự kiện `page`, `prompt-sent`, `reply`, frame `type:error`).
5. Exit 2 và `reason` `auth-required` hoặc `jwt-expired`: chưa vào được desktop. Không gửi lại prompt. Báo người dùng đăng nhập lại / cấp JWT. Exit 1 `disconnected` hoặc `failure`: desktop offline hoặc link hết hạn, xin link mới.
6. Sửa tiếp cùng phiên desktop: `scripts/run-zcode.sh continue /tmp/work/<tên> "sửa …"`.
7. Cần dừng lượt đang chạy: `scripts/run-zcode.sh stop /tmp/work/<tên>`.
8. zcode hỏi quyền công cụ: `scripts/run-zcode.sh approvals /tmp/work/<tên>`. Chỉ khi prompt đã cho phép đúng thao tác đó mới `approve allow`. Nghi ngờ thì `approve deny`. Không có lệnh "luôn cho phép".
9. Tự kiểm tra lại kết quả. Mọi thứ gửi ra ngoài (mail, chat, git push, drive, …) vẫn qua bước duyệt của Grok Bot.

## Lưu ý

- Prompt chạy trên máy thật, với quyền của workspace desktop đang gắn (máy local, SSH, WSL, hoặc Docker). Không giao việc mơ hồ.
- Link và JWT là bí mật. Log driver đã cắt các chuỗi này, nhưng `run.jsonl` vẫn có thể chứa đường dẫn và nội dung hội thoại trên máy người dùng. Giữ thư mục việc ở local.
- Kiểm tra 29/10/2026: link một mình không đủ. Trang dừng ở Sign In; prompt không được gửi. Chưa có JWT thì đừng giả định là agent đã trả lời.
