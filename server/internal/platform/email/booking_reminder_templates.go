package email

import (
	"strconv"
	"strings"
)

// HoursWord is hoursWord: "1 hour", "6 hours".
func HoursWord(hours float64) string {
	if hours == 1 {
		return "1 hour"
	}
	return strconv.FormatFloat(hours, 'f', -1, 64) + " hours"
}

// BookingAnswerReminder is bookingAnswerReminderEmail: the hostel has not answered yet.
func BookingAnswerReminder(answerBy, bookingsURL, code, guestName, guestPhone, hostelName string, hostelShare int64, hoursLeft float64, name, roomType string) Content {
	_ = hostelName // part of HostelBase; the email does not print it
	body := strings.Join([]string{Greeting(name),
		Paragraph("<strong>" + EscapeHTML(guestName) + "</strong> is still waiting for your answer."),
		DetailsTable([]DetailRow{{Label: "Booking", Value: code}, {Label: "Guest", Value: guestName}, {Label: "Phone", Value: guestPhone}, {Label: "Room type", Value: roomType},
			{Emphasis: true, Label: "Answer by", Value: answerBy}, {Label: "You get after they move in", Value: Rupees(hostelShare)}}),
		CTAButton(bookingsURL, "Say yes or no"),
		SmallPrint("If you do not answer by " + EscapeHTML(answerBy) + ", the booking is cancelled, the guest gets all the money back, and it counts as a missed booking."),
	}, "")
	return Content{Category: Billing, Subject: "Please answer " + guestName + "'s booking — only " + HoursWord(hoursLeft) + " left",
		HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Reminder", Heading: "Please answer this booking", Preheader: guestName + " is waiting. Answer by " + answerBy + ".", Urgent: true})}
}

// BookingMoveInReminder is bookingMoveInReminderEmail: the held bed runs out soon.
func BookingMoveInReminder(b BookingFacts, address, bookingURL, directionsURL, holdEndsAt, hostelPhone string, hoursLeft float64, name string, noShowRefund int64) Content {
	button := CTAButton(bookingURL, "View booking")
	if directionsURL != "" {
		button = CTAButton(directionsURL, "Get directions")
	}
	refund := "you do not get the booking fee back"
	if noShowRefund > 0 {
		refund = "you get back " + Rupees(noShowRefund) + " of the booking fee"
	}
	body := strings.Join([]string{Greeting(name),
		Paragraph("Your bed at <strong>" + EscapeHTML(b.HostelName) + "</strong> is kept until <strong>" + EscapeHTML(holdEndsAt) + "</strong>. Only " + HoursWord(hoursLeft) + " left."),
		DetailsTable([]DetailRow{{Label: "Booking", Value: b.Code}, {Label: "Room type", Value: b.RoomType}, {Emphasis: true, Label: "Move in by", Value: holdEndsAt},
			{Label: "Address", Value: address}, {Label: "Hostel phone", Value: hostelPhone}}),
		button,
		Paragraph("Show your " + PlatformName + " ID card at the hostel. If you do not move in by then, you lose the bed and " + refund + "."),
		SmallPrint("Not coming? Cancel early to get more money back. " + TextLink(bookingURL, "View booking") + "."),
	}, "")
	return Content{Category: Billing, Subject: "Move in by " + holdEndsAt + " — booking " + b.Code,
		HTML: EmailLayout(Layout{BodyHTML: body, Eyebrow: "Reminder", Heading: "Time to move in", Preheader: "Move in at " + b.HostelName + " by " + holdEndsAt + ".", Urgent: true})}
}
