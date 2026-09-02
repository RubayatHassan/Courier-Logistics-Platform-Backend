import nodemailer from "nodemailer";
import { env } from "../config/env.js";

const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth:
        env.SMTP_USER && env.SMTP_PASS
          ? { user: env.SMTP_USER, pass: env.SMTP_PASS }
          : undefined,
    })
  : null;

export async function sendEmail(to: string, subject: string, html: string) {
  if (!transporter) throw new Error("SMTP is not configured");
  await transporter.sendMail({ from: env.MAIL_FROM, to, subject, html });
}

export function verificationEmail(name: string, code: string, token: string) {
  const link = `${env.APP_URL}/api/v1/auth/verify-email?token=${encodeURIComponent(token)}`;
  return {
    subject: "Verify your Courier Platform email",
    html: `<p>Hello ${name},</p><p>Your verification code is <strong>${code}</strong>.</p><p><a href="${link}">Verify email address</a></p><p>This link expires in 15 minutes.</p>`,
  };
}

export function passwordResetEmail(name: string, code: string, token: string) {
  const link = `${env.APP_URL}/api/v1/auth/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: "Reset your Courier Platform password",
    html: `<p>Hello ${name},</p><p>Your password reset code is <strong>${code}</strong>.</p><p><a href="${link}">Open password reset</a></p><p>This link expires in 15 minutes.</p>`,
  };
}
