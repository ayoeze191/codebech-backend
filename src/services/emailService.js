// src/services/emailService.js
const nodemailer = require("nodemailer");

class EmailService {
  constructor() {
    this.transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  async sendInvitation(email, token, assessmentTitle, assessmentId) {
    if (process.env.EMAIL_ENABLED === "false") return;
    const link = `${process.env.FRONTEND_URL}/assessment/${token}/${assessmentId}`;

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: `Coding Assessment Invitation: ${assessmentTitle}`,
      html: `
        <h2>You're invited to take a coding assessment</h2>
        <p>Assessment: ${assessmentTitle}</p>
        <p>Click the link below to start:</p>
        <a href="${link}">${link}</a>
        <p>This link will expire in 7 days.</p>
      `,
    });
  }

  async sendSubmissionConfirmation(email, assessmentTitle, score) {
    if (process.env.EMAIL_ENABLED === "false") return;

    await this.transporter.sendMail({
      from: process.env.SMTP_FROM,
      to: email,
      subject: `Assessment Submitted: ${assessmentTitle}`,
      html: `
        <h2>Your submission has been received</h2>
        <p>Assessment: ${assessmentTitle}</p>
        <p>Score: ${score}%</p>
        <p>You will receive results once reviewed.</p>
      `,
    });
  }
}

module.exports = new EmailService();
