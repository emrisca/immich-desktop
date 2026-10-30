//! A QR code for the address a phone should open.
//!
//! It is drawn here rather than in the frontend so the matrix comes from one
//! encoder with tests behind it, and the UI only ever receives a string it can
//! put in the DOM.

const QUIET_ZONE: usize = 4;

/// The modules, row by row. `true` is a dark module.
pub fn matrix(text: &str) -> Result<(usize, Vec<bool>), String> {
    let code = qrcode::QrCode::new(text.as_bytes()).map_err(|error| error.to_string())?;
    let width = code.width();
    let cells = code
        .to_colors()
        .into_iter()
        .map(|color| color == qrcode::Color::Dark)
        .collect();
    Ok((width, cells))
}

/// An SVG that fills its container. A quiet zone is included because scanners
/// refuse a code with no margin, and it is drawn dark-on-white regardless of the
/// app's dark theme — inverted codes are not readable by every phone camera.
pub fn svg(text: &str) -> Result<String, String> {
    let (width, cells) = matrix(text)?;
    let size = width + QUIET_ZONE * 2;

    let mut path = String::new();
    for (index, dark) in cells.into_iter().enumerate() {
        if !dark {
            continue;
        }
        let x = index % width + QUIET_ZONE;
        let y = index / width + QUIET_ZONE;
        // One path with a subpath per module keeps the markup small enough to
        // re-render whenever the address changes.
        path.push_str(&format!("M{x} {y}h1v1h-1z"));
    }

    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" \
         shape-rendering=\"crispEdges\" role=\"img\" aria-label=\"QR code for the server address\">\
         <rect width=\"{size}\" height=\"{size}\" fill=\"#ffffff\"/>\
         <path d=\"{path}\" fill=\"#000000\"/></svg>"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The only test that matters: put the modules back through a decoder and get
    /// the address out. Producing an SVG proves nothing on its own.
    #[test]
    fn a_generated_code_decodes_back_to_the_address() {
        let address = "http://192.168.1.42:2283";
        let (width, cells) = matrix(address).expect("encoded");

        // Four pixels per module and a quiet zone: the detector works on
        // scanlines, so it needs more than one pixel of separation.
        let scale = 4;
        let size = (width + QUIET_ZONE * 2) * scale;
        let mut pixels = vec![255u8; size * size];
        for (index, dark) in cells.into_iter().enumerate() {
            if !dark {
                continue;
            }
            let x = (index % width + QUIET_ZONE) * scale;
            let y = (index / width + QUIET_ZONE) * scale;
            for dy in 0..scale {
                for dx in 0..scale {
                    pixels[(y + dy) * size + x + dx] = 0;
                }
            }
        }

        let mut image = rqrr::PreparedImage::prepare_from_greyscale(size, size, |x, y| {
            pixels[y * size + x]
        });
        let grids = image.detect_grids();
        assert_eq!(grids.len(), 1, "expected exactly one QR code in the image");
        let (_, decoded) = grids[0].decode().expect("decodes");
        assert_eq!(decoded, address);
    }

    #[test]
    fn the_markup_is_a_square_svg_with_a_quiet_zone() {
        let markup = svg("http://10.0.0.2:2283").expect("encoded");
        assert!(markup.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(markup.contains("fill=\"#ffffff\""));
        assert!(markup.ends_with("</svg>"));
    }
}
