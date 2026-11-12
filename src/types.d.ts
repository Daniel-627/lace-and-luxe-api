declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      customerId?: number;
    }
  }
}
export {};
