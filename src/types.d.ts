declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      customerId?: number;
      staff?: { id: number; name: string; email: string; role: string };
    }
  }
}
export {};
