<div dir="rtl" align="right">

# کتاب‌خان استودیو (Ketabkhan Studio)

**کتاب‌خوان محلی، سریع و حرفه‌ای برای فایل‌های PDF و EPUB — با پشتیبانی از متون فارسی و انگلیسی (RTL/LTR)، هایلایت دوحالته، بوکمارک، فهرست هوشمند، خروجی Obsidian و قابلیت اجرا روی مک، ویندوز و اندروید.**

[بازگشت به README دوزبانه](./README.md)

---

## نصب سریع از طریق کامندلاین

### مک (macOS) و لینوکس
```bash
curl -fsSL https://raw.githubusercontent.com/am333ni7y/book-reader-studio/main/install.sh | bash
ketabkhan --open
```

### ویندوز (PowerShell)
```powershell
irm https://raw.githubusercontent.com/am333ni7y/book-reader-studio/main/install.ps1 | iex
ketabkhan --open
```

### اندروید (Termux — اجرای آفلاین روی گوشی)
```bash
pkg update -y && pkg install -y curl
curl -fsSL https://raw.githubusercontent.com/am333ni7y/book-reader-studio/main/install.sh | bash
ketabkhan --open
```

### اندروید (اتصال از طریق وای‌فای به کتابخانه کامپیوتر)
روی مک یا ویندوز اجرا کنید:
```bash
ketabkhan --lan
```
سپس آدرس شبکه چاپ‌شده در ترمینال را در مرورگر کروم گوشی باز کنید و دکمه نصب اپلیکیشن را بزنید.

---

## دستورات کاربردی CLI
- `ketabkhan start --open`: اجرای سرور و باز شدن مرورگر
- `ketabkhan add /path/to/book.epub`: افزودن کتاب EPUB یا PDF از ترمینال
- `ketabkhan seed`: ساخت کتاب‌های نمونه PDF و EPUB
- `ketabkhan doctor`: بررسی سلامت Node.js، SQLite و مسیرهای ذخیره‌سازی

</div>
