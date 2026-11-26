<div dir="rtl" align="right">

# کتاب‌خان استودیو (Ketabkhan Studio)

**کتاب‌خوان محلی، سریع و حرفه‌ای برای فایل‌های PDF و EPUB — با پشتیبانی از متون فارسی و انگلیسی (RTL/LTR)، هایلایت دوحالته، بوکمارک، فهرست هوشمند، خروجی Obsidian و اپلیکیشن بومی برای مک، ویندوز و اندروید.**

[بازگشت به README دوزبانه](./README.md)

---

## 📲 نصب اپلیکیشن با یک کلیک (بدون نیاز به کد و ترمینال)

فایل نصبی دستگاه خود را از [**صفحه Releases گیتهاب**](https://github.com/am333ni7y/book-reader-studio/releases/latest) دانلود کنید و فقط با لمس یا کلیک روی آیکون برنامه اجرا کنید:

- **مک (macOS):** فایل `.dmg` را باز کنید، **Ketabkhan Studio** را در پوشه `Applications` بگذارید و روی آیکون آن دابل‌کلیک کنید.
- **ویندوز (Windows):** فایل `Ketabkhan-Studio-Windows-Setup.exe` (یا نسخه `Portable.exe` بدون نیاز به نصب) را اجرا کنید و روی آیکون دسکتاپ کلیک کنید.
- **اندروید (Android):** فایل `Ketabkhan-Studio-Android.apk` را روی گوشی نصب کنید و آیکون **کتاب‌خان استودیو** را باز کنید (کاملاً آفلاین و مستقل، بدون نیاز به کامپیوتر یا ترموکس).

---

## نصب سریع از طریق کامندلاین (اختیاری)

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

### اندروید (Termux — اجرای آفلاین در ترمینال)
```bash
pkg update -y && pkg install -y curl
curl -fsSL https://raw.githubusercontent.com/am333ni7y/book-reader-studio/main/install.sh | bash
ketabkhan --open
```

---

## دستورات کاربردی CLI
- `ketabkhan start --open`: اجرای سرور و باز شدن مرورگر
- `ketabkhan add /path/to/book.epub`: افزودن کتاب EPUB یا PDF از ترمینال
- `ketabkhan seed`: ساخت کتاب‌های نمونه PDF و EPUB
- `ketabkhan doctor`: بررسی سلامت Node.js، SQLite و مسیرهای ذخیره‌سازی

</div>
