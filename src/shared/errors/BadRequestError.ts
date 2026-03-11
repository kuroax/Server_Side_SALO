import { AppError } from '#/shared/errors/AppError.js';

export class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 'BAD_REQUEST', 400);
  }
}