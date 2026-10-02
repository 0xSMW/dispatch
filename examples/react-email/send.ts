import { createElement } from "react";
import { Dispatch } from "@dispatchmail/sdk";
import Hello from "./emails/hello.js";

const apiKey = process.env.DISPATCH_API_KEY;
if (!apiKey) {
  throw new Error("DISPATCH_API_KEY is required");
}

const client = new Dispatch({ apiKey, baseUrl: process.env.DISPATCH_BASE_URL });
const sent = await client.emails.send({
  from: process.env.DISPATCH_FROM ?? "hello@example.com",
  to: process.env.DISPATCH_TO ?? "ada@example.com",
  subject: "Welcome, Ada",
  react: createElement(Hello, {
    name: "Ada",
    actionUrl: "https://example.com/start",
  }),
});

if (sent.error) {
  throw new Error(sent.error.message);
}

console.log(sent.data);
