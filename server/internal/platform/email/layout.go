package email

import "strings"

// PlatformName is PLATFORM_NAME (packages/shared/src/brand/brand.ts).
const PlatformName = "HostelPalika"

// PlatformSiteURL is PLATFORM_SITE_URL.
const PlatformSiteURL = "https://hostelpalika.com"

// Content is EmailContent: a template's category, subject and HTML.
type Content struct {
	Category Category
	Subject  string
	HTML     string
}

// EscapeHTML is the templates' escapeHtml (html.EscapeString writes &#34; for ", not &quot;).
var EscapeHTML = strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;").Replace

const font = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"

const (
	colorBody   = "#3f3f46"
	colorBorder = "#e4e4e7"
	colorBrand  = "#0a8a4b"
	colorCanvas = "#f4f4f5"
	colorCard   = "#ffffff"
	colorDanger = "#dc2626"
	colorMuted  = "#71717a"
	colorStrong = "#18181b"
)

// UnsubscribeSlot is where the sender puts an unsubscribe line.
const UnsubscribeSlot = "<!--unsubscribe-->"

// Layout is emailLayout's options.
type Layout struct {
	BodyHTML, Eyebrow, Heading, Preheader, SiteName string
	Urgent                                          bool
}

func preheaderHTML(text string) string {
	return `<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:` + colorCanvas + `;">` +
		EscapeHTML(text) + strings.Repeat("&#847;&zwnj;&nbsp;", 60) + `</div>`
}

// EmailLayout is the shared HTML shell, byte-for-byte as layout.ts writes it.
func EmailLayout(o Layout) string {
	name := strings.TrimSpace(o.SiteName)
	if name == "" {
		name = PlatformName
	}
	brand := EscapeHTML(name)
	eyebrow := o.Eyebrow
	if eyebrow == "" && o.Urgent {
		eyebrow = "Urgent"
	}
	eyebrowColor := colorMuted
	if o.Urgent {
		eyebrowColor = colorDanger
	}
	pre, eb := "", ""
	if o.Preheader != "" {
		pre = preheaderHTML(o.Preheader)
	}
	if eyebrow != "" {
		eb = `<p style="margin:0 0 8px;font-family:` + font + `;font-size:12px;line-height:16px;font-weight:600;letter-spacing:0.6px;text-transform:uppercase;color:` + eyebrowColor + `;">` + EscapeHTML(eyebrow) + `</p>`
	}
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>` + EscapeHTML(o.Heading) + `</title>
  </head>
  <body style="margin:0;padding:0;background:` + colorCanvas + `;">
    ` + pre + `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:` + colorCanvas + `;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
            <tr>
              <td style="padding:0 4px 16px;font-family:` + font + `;font-size:17px;line-height:24px;font-weight:700;letter-spacing:-0.2px;color:` + colorBrand + `;">` + brand + `</td>
            </tr>
            <tr>
              <td style="padding:32px;background:` + colorCard + `;border:1px solid ` + colorBorder + `;border-radius:12px;font-family:` + font + `;">
                ` + eb + `
                <h1 style="margin:0 0 20px;font-family:` + font + `;font-size:22px;line-height:30px;font-weight:600;color:` + colorStrong + `;">` + EscapeHTML(o.Heading) + `</h1>
                ` + o.BodyHTML + `
              </td>
            </tr>
            <tr>
              <td style="padding:20px 4px 0;font-family:` + font + `;font-size:12px;line-height:18px;color:` + colorMuted + `;">
                Sent by ` + brand + ` · Powered by Softmato<br>
                If you were not expecting this email, you can safely ignore it.` + UnsubscribeSlot + `
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

// CTAButton is ctaButton: the one action an email asks for.
func CTAButton(url, label string) string {
	href := EscapeHTML(url)
	return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:28px 0 12px;">
    <tr>
      <td style="border-radius:8px;background:` + colorBrand + `;">
        <a href="` + href + `" style="display:inline-block;padding:12px 24px;font-family:` + font + `;font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">` + EscapeHTML(label) + `</a>
      </td>
    </tr>
  </table>
  <p style="margin:0 0 20px;font-family:` + font + `;font-size:12px;line-height:18px;color:` + colorMuted + `;">If the button does not work, open this link:<br><a href="` + href + `" style="color:` + colorMuted + `;text-decoration:underline;word-break:break-all;">` + href + `</a></p>`
}

// Paragraph is paragraph: trusted markup.
func Paragraph(text string) string {
	return `<p style="margin:0 0 16px;font-family:` + font + `;font-size:15px;line-height:24px;color:` + colorBody + `;">` + text + `</p>`
}
