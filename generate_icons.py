import os
from PIL import Image, ImageDraw, ImageFont

def draw_icon(size):
    # Create an image with transparent background
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # Scale factors
    margin = int(size * 0.1)

    # Draw background with rounded corners (simulated via polygon or just a circle, but usually extension icons don't strictly need rounded corners as Chrome crops them, but we can do a nice circle or squircle)
    # Let's draw a nice rounded rectangle shape
    rect_box = [margin, margin, size - margin, size - margin]
    radius = int(size * 0.2)
    d.rounded_rectangle(rect_box, radius=radius, fill=(99, 102, 241, 255)) # Indigo 500

    # Draw a document
    doc_margin = int(size * 0.25)
    doc_box = [doc_margin, doc_margin, size - doc_margin * 1.2, size - doc_margin]
    doc_radius = int(size * 0.05)
    d.rounded_rectangle(doc_box, radius=doc_radius, fill=(255, 255, 255, 255))

    # Draw lines on the document
    line_start_x = int(size * 0.35)
    line_end_x = int(size * 0.65)
    line_y_start = int(size * 0.35)
    line_gap = int(size * 0.1)

    for i in range(4):
        y = line_y_start + i * line_gap
        width = 2
        if size < 32:
            width = 1
        d.line((line_start_x, y, line_end_x, y), fill=(203, 213, 225, 255), width=width)

    # Draw an AI sparkle/star in the bottom right corner
    star_center_x = int(size * 0.70)
    star_center_y = int(size * 0.70)
    star_size = int(size * 0.15)

    # Four-pointed star shape
    points = [
        (star_center_x, star_center_y - star_size), # Top
        (star_center_x + star_size * 0.3, star_center_y - star_size * 0.3), # Top Right
        (star_center_x + star_size, star_center_y), # Right
        (star_center_x + star_size * 0.3, star_center_y + star_size * 0.3), # Bottom Right
        (star_center_x, star_center_y + star_size), # Bottom
        (star_center_x - star_size * 0.3, star_center_y + star_size * 0.3), # Bottom Left
        (star_center_x - star_size, star_center_y), # Left
        (star_center_x - star_size * 0.3, star_center_y - star_size * 0.3) # Top Left
    ]

    d.polygon(points, fill=(250, 204, 21, 255)) # Yellow 400

    return img

def main():
    icons_dir = "icons"
    if not os.path.exists(icons_dir):
        os.makedirs(icons_dir)

    sizes = [16, 48, 128]
    for size in sizes:
        img = draw_icon(size)
        file_path = os.path.join(icons_dir, f"icon{size}.png")
        # Resize for better anti-aliasing (draw large, resize down) - a simpler way is to just draw it at scale.
        # Let's use antialiasing by drawing at 4x scale and resizing down
        large_size = size * 4
        large_img = draw_icon(large_size)
        final_img = large_img.resize((size, size), Image.Resampling.LANCZOS)

        final_img.save(file_path, "PNG")
        print(f"Generated {file_path}")

if __name__ == "__main__":
    main()
