import { BadRequestError } from "@/common/errors/HTTPError"
import MovimentationService, {
  insertMovimentationSchema,
} from "@/services/MovimentationService"
import type { RequestHandler } from "express"

class MovimentationController {
  private movimentationService: typeof MovimentationService

  constructor(movimentationService: typeof MovimentationService) {
    this.movimentationService = movimentationService
  }

  index: RequestHandler = async (_req, res) => {
    const movimentations = await this.movimentationService.getMovimentations()

    res.json(movimentations)
  }

  show: RequestHandler = async (req, res) => {
    const movimentationId = req.params.id

    if (!movimentationId) {
      throw new BadRequestError("Movimentation ID is required")
    }

    const movimentation =
      await this.movimentationService.getFullMovimentationById(movimentationId)

    res.json(movimentation)
  }

  create: RequestHandler = async (req, res) => {
    const newMovimentation = req.body

    const parsedMovimentation =
      insertMovimentationSchema.safeParse(newMovimentation)

    if (!parsedMovimentation.success) {
      throw new BadRequestError("Invalid movimentation data")
      /* return res.status(400).json({
        message: "Invalid movimentation data",
        errors: parsedMovimentation.error.errors,
      }) */
    }

    const movimentation = await this.movimentationService.createMovimentation(
      parsedMovimentation.data,
    )

    res.json(movimentation)
  }

  fetch: RequestHandler = async (_req, res) => {
    const movimentation =
      await this.movimentationService.fetchNewMovimentations()

    res.json(movimentation)
  }
}

export default new MovimentationController(MovimentationService)
