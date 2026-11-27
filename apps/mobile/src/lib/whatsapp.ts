/** `wa.me` takes digits with the country code; a local 98… number gets Nepal's 977. */
export function whatsappUrl(phone: string, text?: string) {
  const digits = phone.replace(/\D/g, "");
  const number = digits.length === 10 && digits.startsWith("9") ? `977${digits}` : digits;

  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}
