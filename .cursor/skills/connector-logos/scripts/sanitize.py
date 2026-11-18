# python3 -I sanitize.py <in.svg> <out.svg>
# Strips everything active or external from a downloaded SVG. Run with -I: the input is untrusted.
import re, sys
import xml.etree.ElementTree as ET

SVGNS = "http://www.w3.org/2000/svg"
XL = "http://www.w3.org/1999/xlink"
ET.register_namespace("", SVGNS)
ET.register_namespace("xlink", XL)
DROP = {
    "script", "foreignObject", "image", "iframe", "embed", "object", "a", "title", "desc", "metadata",
    "animate", "set", "animateMotion", "animateTransform", "animateColor", "discard",
}
DROP_ATTR = {"role", "aria-hidden", "enable-background"}


def local(tag):
    return tag.split("}")[-1]


def clean(el):
    for ch in list(el):
        if local(ch.tag) in DROP:
            el.remove(ch)
        else:
            clean(ch)
    for k in list(el.attrib):
        lk, v = local(k), el.attrib[k]
        if lk.lower().startswith("on") or lk in DROP_ATTR:
            del el.attrib[k]
        elif lk == "href" and not v.startswith("#"):
            del el.attrib[k]  # external href or data: URI
        elif "url(" in v.lower() and not re.fullmatch(r"[^()]*url\(#[^)]+\)[^()]*", v, re.I):
            del el.attrib[k]  # url() that points outside the file
        elif k.startswith("{") and not k.startswith("{" + XL):
            del el.attrib[k]  # foreign-namespace attributes (Inkscape, rdf, ...)
    if local(el.tag) == "style" and re.search(r"@import|url\((?!['\"]?#)", el.text or "", re.I):
        el.text = ""


src, dst = sys.argv[1], sys.argv[2]
txt = re.sub(r"<\?xml[^>]*\?>|<!DOCTYPE[^>]*>", "", open(src, encoding="utf-8").read())
root = ET.fromstring(txt)
clean(root)
if "viewBox" not in root.attrib and "width" in root.attrib and "height" in root.attrib:
    w, h = (re.sub(r"[^\d.]", "", root.attrib[a]) for a in ("width", "height"))
    root.attrib["viewBox"] = f"0 0 {w} {h}"
for k in ("width", "height", "id", "style"):
    root.attrib.pop(k, None)
open(dst, "w").write(ET.tostring(root, encoding="unicode").replace("ns0:", "").replace(":ns0", ""))
print(dst, root.attrib.get("viewBox"))
