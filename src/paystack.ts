import axios from "axios";

const api = axios.create({
  baseURL: "https://api.paystack.co",
  headers: {
    Authorization: `Bearer ${process.env.PAYSTACK_SECRET || ""}`,
  },
});

export async function createPaymentLink(
  email: string,
  amount: number,
  reference: string,
): Promise<string> {
  try {
    const callbackUrl = process.env.CALLBACK_URL || "https://yourdomain.com/payment/success";
    const res = await api.post("/transaction/initialize", {
      email,
      amount: amount * 100, // Paystack expects amount in kobo (subunit)
      reference,
      callback_url: callbackUrl,
    });

    if (res.data?.status && res.data?.data) {
      return res.data.data.authorization_url;
    }

    throw new Error(res.data?.message || "Failed to initialize transaction");
  } catch (error) {
    const err = error as { response?: { data?: unknown }; message?: string };
    console.error(
      "Error creating Paystack payment link:",
      err.response?.data || err.message || String(error),
    );
    throw error;
  }
}
