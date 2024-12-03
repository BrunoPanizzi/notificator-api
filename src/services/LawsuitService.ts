import { createInsertSchema, createSelectSchema } from "drizzle-zod"
import type { z } from "zod"

import { db } from "@/database"
import { lawsuit } from "@/database/schema"

import ClientService from "./ClientService"
import JudiceService from "./JudiceService"
import MovimentationService from "./MovimentationService"

const selectLawsuitSchema = createSelectSchema(lawsuit)
const insertLawsuitSchema = createInsertSchema(lawsuit)

type Lawsuit = z.infer<typeof selectLawsuitSchema>
type NewLawsuit = z.infer<typeof insertLawsuitSchema>

class LawsuitService {
  async listLawsuits() {
    return await db.query.lawsuit.findMany({ with: { client: true } })
  }

  async getByCNJ(cnj: string) {
    console.log("gettinbycnj")
    const ls = await db.query.lawsuit.findFirst({
      where: (lawsuit, { eq }) => eq(lawsuit.cnj, cnj),
      with: { client: true, movimentations: true },
    })
    console.log("lawsuit", ls)
    return ls
  }

  async getByJudiceId(judiceId: number) {
    return await db.query.lawsuit.findFirst({
      where: (lawsuit, { eq }) => eq(lawsuit.judiceId, judiceId),
    })
  }

  async create(newLawsuit: NewLawsuit) {
    const [createdLawsuit] = await db
      .insert(lawsuit)
      .values(newLawsuit)
      .returning()

    return createdLawsuit
  }

  async getOrCreateByCNJ(cnj: string) {
    console.log(`Searching for lawsuit with cnj: ${cnj}`)
    const dbLawsuit = await this.getByCNJ(cnj)

    if (dbLawsuit) {
      console.log(`Lawsuit ${cnj} found in database`)
      return dbLawsuit
    }

    const judiceLawsuit = await JudiceService.searchLawsuitByCNJ(cnj)

    if (!judiceLawsuit) {
      console.log("lawsuit not found in judice")
      return null
    }

    return this.getOrCreateByJudiceId(judiceLawsuit.f_id)
  }

  async getOrCreateByJudiceId(judiceId: number) {
    const dbLawsuitJudiceId = await this.getByJudiceId(judiceId)

    if (dbLawsuitJudiceId) {
      console.log(`Lawsuit with judice id ${judiceId} already exists`)
      return dbLawsuitJudiceId
    }

    const judiceLawsuit =
      await JudiceService.lawsuitWithMovimentationsByJudiceId(judiceId)

    console.log(judiceLawsuit)

    if (!judiceLawsuit) {
      throw new Error("Judice lawsuit not found")
    }

    const client = await ClientService.getOrCreateByJudiceId(
      judiceLawsuit.clientId,
    )

    if (!client) {
      console.log("client not found when creating lawsuit")
      return null
    }

    const createdLawsuit = await this.create({
      judiceId: judiceId,
      clientId: client.id,
      cnj: judiceLawsuit.cnj,
    })

    console.log(`Lawsuit ${judiceLawsuit.cnj} created!`)

    console.log(
      `Found  ${judiceLawsuit.movimentations.length} movimentations for lawsuit ${judiceLawsuit.cnj}`,
    )

    for (const movimentation of judiceLawsuit.movimentations) {
      if (
        !movimentation.date ||
        !movimentation.lastModification ||
        !movimentation.type ||
        !movimentation.judiceId
      ) {
        console.log("Invalid movimentation", movimentation)
        continue
      }

      const newMov = await MovimentationService.createMovimentation({
        judiceId: movimentation.judiceId,
        expeditionDate: movimentation.lastModification,
        finalDate: movimentation.date,
        type: movimentation.type === "audiencia" ? "AUDIENCIA" : "PERICIA",
        lawsuitId: createdLawsuit.id,
      })

      console.log(`Movimentation ${newMov.id} created!`)
    }

    return createdLawsuit
  }
}

export default new LawsuitService()
