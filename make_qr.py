import qrcode
from qrcode.constants import ERROR_CORRECT_H

URL = "http://10.60.250.137:3000"

qr = qrcode.QRCode(
    version=None,
    error_correction=ERROR_CORRECT_H,
    box_size=20,
    border=2,
)
qr.add_data(URL)
qr.make(fit=True)

img = qr.make_image(fill_color="#0b0d1a", back_color="#ffffff").convert("RGBA")
img.save("qr_code.png")
print("QR size:", img.size)
