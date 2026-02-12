import { type ParsedUrlQueryInput, stringify } from "node:querystring"
import { TZDate } from "@date-fns/tz"
import { AxiosError, type AxiosInstance } from "axios"
import * as cheerio from "cheerio"
import { parse as parseCSV } from "csv"
import { parse } from "date-fns"
import { ptBR } from "date-fns/locale/pt-BR"
import { inject, injectable } from "inversify"
import { z } from "zod"

import { InternalServerError, NotFoundError } from "@/common/errors/HTTPError"

import type { createJudiceApiClient } from "./apiClient"

const processSchema = z.object({
  f_id: z.coerce.number(),
  f_number: z.string(),
  f_cnj_number: z.string(),
  f_client: z.number(), // client judice id
  f_situation: z.number(),
  f_actiontype: z.string().nullable(),
  client_name: z.string(),
  area_name: z.string(),
  parte_adversa: z.string(),
  f_relevant: z.number(),
})

const lawsuitSearchSchema = z.object({
  messageError: z.string(),
  success: z.boolean(),
  recordsTotal: z.number(),
  recordsFiltered: z.number(),
  data: z.array(processSchema),
})

const publicationSchema = z.object({
  "0": z.string(), // chekcbox
  "1": z.string(), // date
  "2": z.string(), // cnj processo
  "3": z.string(), // iboti
  "4": z.string(), // user
  "5": z.string(), // button
})

type RawPublication = z.infer<typeof publicationSchema>

const publicationsSearchSchema = z.object({
  recordsTotal: z.number(),
  recordsFiltered: z.number(),
  data: z.array(publicationSchema),
})

type JudicePublication = {
  judiceId: number
  expeditionDate: Date
  lawsuitCNJ: string
  // lawsuitJudiceId: number
}

function formatPublication(rawPublication: RawPublication): JudicePublication {
  const judiceId = rawPublication[0].replace(/.*value="/, "").replace(/">/, "")

  return {
    judiceId: Number(judiceId),
    expeditionDate: parse(rawPublication[1], "dd/MM/yyyy", new Date()),
    lawsuitCNJ: rawPublication[2],
  }
}

const singlePublicationSchema = z.object({
  f_id: z.coerce.number(),
  f_publisher_date: z.string(),
  f_publisher: z.string(),
  f_number: z.string(),
  f_lawyername: z.string().nullable(),
  f_clietname: z.string(),
  f_vara: z.string(),
  f_orgao: z.string(),
  f_process_all: z.string(),
  f_cod_int: z.string(), // fornecedor
  f_inserted: z.string(),
  f_description: z.string(),
  f_process: z.number(), // judice lawsuit id
})

const completeArrayAppPublicationSchema = z.array(
  z.object({
    f_id: z.coerce.number(),
    f_name: z.string(),
  }),
)

const publicationSearchSchema = z.object({
  info: z.array(singlePublicationSchema),
  completeArrayAppPublication: completeArrayAppPublicationSchema,
})

const lawsuitInfoSchema = z.object({
  processo: z.string(),
  cnj: z.string(),
  fase: z.string(),
  área: z.string(),
  "tipo de ação": z.string(),
  cidade: z.string(),
  partes: z.string(),
})

const judiceMethodAjaxGetProcessInfoBarSchema = z.object({
  info: z.string(),
  // and some other stuff we dont need
})

const clientSearchSchema = z.object({
  info: z.string(),
})

const clientInfoSchema = z.object({
  nome: z.string().min(1),
  id: z.coerce.number(),
  cpf: z.string().optional(),
  nascimento: z.string().optional(),
  "estado civil": z.string().optional(),
  "e-mail": z.string().optional(),
  celular: z.string().optional(),
})

const agendaAssignmentSchema = z.object({
  Data: z.string(),
  "Data Fatal": z.string(),
  "Data de cadastro": z.string(),
  Processo: z.string(),
  Tipo: z.string(),
  Texto: z.string(),
  Cliente: z.string(),
})

const agendaAssignmentMapper = (
  data: z.infer<typeof agendaAssignmentSchema>,
) => ({
  date: parse(data.Data, "dd/MM/yyyy", new Date()),
  deadline: parse(data["Data Fatal"], "dd/MM/yyyy", new Date()),
  registrationDate: parse(data["Data de cadastro"], "dd/MM/yyyy", new Date()),
  lawsuitCNJ: data.Processo,
  type: data.Tipo,
  text: data.Texto,
  client: data.Cliente,
})

const appointmentsResponseSchema = z.object({
  success: z.boolean(),
  messageError: z.string(),
  draw: z.number(),
  recordsTotal: z.number(),
  recordsFiltered: z.number(),
  data: z.array(z.string()),
})

type RequestOptions = {
  method: "GET" | "POST"
  body?: ParsedUrlQueryInput | FormData
}

@injectable()
export class JudiceService {
  private httpClient: AxiosInstance | null = null
  constructor(
    @inject("createJudiceApiClient")
    private createHttpClient: typeof createJudiceApiClient,
  ) {}

  private async extractAudiencias(data: string) {
    const $ = cheerio.load(data)

    const res = $("div.process-list li:even")

    const arr = res
      .map((i, el) =>
        $(el).extract({
          link: {
            selector: "div.details a",
            value: (el) => {
              const href = $(el).attr("href")
              if (!href) return null

              return href
            },
          },
          isActive: {
            selector: "div.calendar",
            value: (el) => $(el).hasClass("green"),
          },
          date: {
            selector: "div.calendar",
            value: (el) =>
              parse(
                $(el).text(),
                "ddMMM/yyyyHH:mm",
                TZDate.tz("America/Sao_Paulo"),
                { locale: ptBR },
              ),
          },
          details: "div.details",
          type: {
            selector: "div.details > strong",
            value: (el) => {
              const normalized = $(el)
                .text()
                .normalize("NFKD")
                // biome-ignore lint/suspicious/noMisleadingCharacterClass: <explanation>
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()

              if (normalized.includes("audiencia")) {
                return "audiencia" as const
              }
              if (normalized.includes("pericia")) {
                return "pericia" as const
              }
            },
          },
          // conciliacao, instrucao, inicial
          variant: {
            selector: "div.details > strong",
            value: (el) => {
              const normalized = $(el)
                .text()
                .normalize("NFKD")
                // biome-ignore lint/suspicious/noMisleadingCharacterClass: <explanation>
                .replace(/[\u0300-\u036f]/g, "")
                .toLowerCase()

              if (normalized.includes("audiencia")) {
                return normalized.replace("audiencia", "").replace("de", "").trim()
              }
              return null
            },
          },
          lastModification: {
            selector: "div.details",
            value: (el) => {
              const dateTimeMatches = $(el)
                .text()
                .match(/Modificado .* em (\d\d\/\d\d\/\d\d\d\d \d\d:\d\d:\d\d)/)
              const dateTime = dateTimeMatches?.[1]
              if (!dateTime) return undefined

              return parse(dateTime, "dd/MM/yyyy HH:mm:ss", new Date())
            },
          },
          judiceId: {
            selector: "div.details",
            value: (el) => {
              const idMatches = $(el)
                .text()
                .match(/\(ID: (\d*)\)/)
              const id = idMatches?.[1]
              if (!id || Number.isNaN(Number(id))) return undefined

              return Number(id)
            },
          },
        }),
      )
      .toArray()
      .filter((a) => a.date && a.lastModification && a.type)

    return arr
  }

  // TODO: add error handling and logging, this might expolde at any moment
  private async extractLawsuitInfo(data: string) {
    try {
      const $ = cheerio.load(data)

      const client = $("h2.block > a").attr("href")
      const clientId = Number(client?.match(/\d+$/)?.[0])

      const result = {} as Record<string, string>

      $("div.well")
        .find("b")
        .each((_, element) => {
          const key = $(element)
            .text()
            .replaceAll(/[:-]/g, "")
            .trim()
            .toLowerCase()

          const sibling = $(element).get(0)?.nextSibling
          if (!sibling) return

          let value = $(sibling).text().trim()
          // cnj has a '-' in it, so we don't split it
          if (key !== "processo" && key !== "cnj") {
            value = value.split("-").at(0)?.trim() || value
          }

          if (key) {
            result[key] = value
          }
        })

      const { cnj, partes } = lawsuitInfoSchema.parse(result)

      return {
        adverseParty: partes,
        clientId,
        cnj,
      }
    } catch (e) {
      console.error("Extract lawsuit info failed.")
      console.log(data)
      console.log(e)
    }
  }

  private extractAppointment(
    el: unknown,
    $: cheerio.CheerioAPI,
    index: number,
  ) {
    const $el = $(el as never)
    const href = $el.find("a").attr("href")
    const lawsuitJudiceId = Number.parseInt(href?.replaceAll(/\D/g, "") || "")

    if (!lawsuitJudiceId) {
      return undefined
    }

    const lawsuitCNJ = $el.find("a").text()

    const buttons = $el.find("button")

    const [assignmentJudiceId] = buttons
      .map((_, btn) => {
        const action = $(btn).attr("onclick")
        if (action?.includes("loadProceedingAppointmentModal")) {
          const id = Number.parseInt(action.split(",")[0].replaceAll(/\D/g, ""))
          return id
        }
        return undefined
      })
      .toArray()
      .filter(Boolean)

    return {
      lawsuitJudiceId,
      lawsuitCNJ,
      assignmentJudiceId,
    }
  }

  private async extractAssignments(data: string) {
    const $ = cheerio.load(data)

    return $("div#agenda li:has(div)")
      .map((i, el) => this.extractAppointment(el, $, i))
      .toArray()
      .filter(Boolean)
  }

  private async makeRequest(
    path: string,
    options: RequestOptions,
    retry = true,
  ): Promise<unknown> {
    try {
      if (!this.httpClient) {
        this.httpClient = await this.createHttpClient()
      }
      const response = await this.httpClient.request({
        url: `https://legala.officeadv.com.br/${path}`,
        method: options.method,
        data:
          options.body instanceof FormData
            ? options.body
            : stringify(options.body),
      })

      return response.data
    } catch (e) {
      if (e instanceof AxiosError) {
        // this makes sense, but judice does not throw 404 errors
        if (e.response?.status === 404) {
          throw new NotFoundError()
        }
        // not authorized requests get a 500 error from judice (for some reason)
        if (e.response?.status === 500) {
          if (!retry) {
            console.log("Failed to make request to Judice API, no retries left")
            throw new InternalServerError()
          }

          console.log("Failed to make request to Judice API, retrying")
          this.httpClient = await this.createHttpClient()

          return this.makeRequest(path, options, false)
        }
      }
      console.log("Unknown error on request to Judice API")
      console.log(e)
      throw new InternalServerError()
    }
  }

  async logoff() {
    await this.makeRequest("pgj/logoff", { method: "GET" })
  }

  async getAssignments() {
    const data = await this.makeRequest("pgj", { method: "POST" })

    return await this.extractAssignments(z.string().parse(data))
  }

  async getAppointments() {
    const data = await this.makeRequest("pgj/appointments/getAppointments", {
      method: "POST",
      body: {
        draw: "1",
        "columns[0][data]": "0",
        "columns[0][name]": "",
        "columns[0][searchable]": "true",
        "columns[0][orderable]": "false",
        "columns[0][search][value]": "",
        "columns[0][search][regex]": "false",
        start: "0",
        length: "-1",
        "search[value]": "",
        "search[regex]": "false",
        processId: "0",
        limitShowScheduling: "10",
        realMonthPicker: "",
        schedule: "true",
        type: "ok",
      },
    })

    const parsed = appointmentsResponseSchema.parse(data)

    if (parsed.data.length === 0) {
      return []
    }

    const $ = cheerio.load(
      `<div class="process-list">${parsed.data.join("")}</div>`,
    )

    return $("li:has(div)")
      .map((i, el) => this.extractAppointment(el, $, i))
      .toArray()
      .filter(Boolean)
  }
  async completeAssignment(assignmentId: number, lawsuitId: number) {
    // idk if all the fields are necessary, but also idc to figure out
    const form = new FormData()
    form.append("appointment_proceeding_rel_id", String(assignmentId))
    form.append("appointment_proceeding_proc_id", String(lawsuitId))
    form.append("appointment_proceeding_needchecklist", "0")
    form.append("is2adv", "0")
    form.append("cboProceedingType", "1530")
    form.append("cboProceedingGenerateDocument", "0")
    form.append("cboProceedingProtocolType", "1")
    form.append("cboClientView", "0")
    form.append("tblOthersAppointments_length", "10")
    const data = await this.makeRequest("pgj/DoProceedingAppointment", {
      method: "POST",
      body: form,
    })

    return data
  }

  async getAudienciasByJudiceId(id: number) {
    const data = await this.makeRequest(`pgj/execution-hearings/${id}`, {
      method: "GET",
    })

    return await this.extractAudiencias(z.string().parse(data))
  }

  async searchLawsuitByCNJ(cnj: string) {
    const data = await this.makeRequest(
      "pgj/search/methodAjaxGetSearchProcess",
      {
        method: "POST",
        body: {
          start: "0",
          length: "25",
          "txtInputSearchTerm[]": cnj,
          "cboType[]": 1,
        },
      },
    )

    const parsedResponse = lawsuitSearchSchema.parse(data)

    if (parsedResponse.data.length === 0) {
      return null
    }

    return parsedResponse.data[0]
  }

  async getLawsuitByJudiceId(judiceId: number) {
    const data = await this.makeRequest(
      "pgj/execution-history/methodAjaxGetProcessInfoBar",
      {
        method: "POST",
        body: { processId: judiceId },
      },
    )

    return await this.extractLawsuitInfo(
      judiceMethodAjaxGetProcessInfoBarSchema.parse(data).info,
    )
  }

  async lawsuitWithMovimentationsByJudiceId(judiceId: number) {
    const lawsuitInfo = await this.getLawsuitByJudiceId(judiceId)

    if (!lawsuitInfo) {
      throw new Error(
        `Lawsuit info is undefined for lawsuit with judice id ${judiceId}`,
      )
    }

    const movimentations = await this.getAudienciasByJudiceId(judiceId)

    return {
      ...lawsuitInfo,
      judiceId,
      movimentations,
    }
  }

  async getAudienciasByCNJ(cnj: string) {
    const lawsuit = await this.searchLawsuitByCNJ(cnj)

    if (!lawsuit) {
      return []
    }

    return await this.getAudienciasByJudiceId(lawsuit.f_id)
  }

  async getPublications() {
    const data = await this.makeRequest(
      "pgj/publication/methodAjaxListPublications",
      {
        method: "POST",
        body: {
          start: 0,
          length: 9999,
          tab: "process",
          // txtDataInicial: "05/11/2024",
          // txtDataFinal: "05/11/2024",
          cboLawyer: 0,
          cboClient: "",
          cboWarning: 0,
          cboRead: 0,
        },
      },
    )

    const parsed = publicationsSearchSchema.parse(data)

    return parsed.data.map(formatPublication)
  }

  async getPublicationByJudiceId(id: number) {
    const data = await this.makeRequest(
      "pgj/publication/methodAjaxGetDescription",
      {
        method: "POST",
        body: { id },
      },
    )

    const parsed = publicationSearchSchema.parse(data)

    return parsed
  }

  async getClientByJudiceId(id: number) {
    const data = await this.makeRequest(
      "pgj/clients/ajax-get-clients-infobar",
      { method: "POST", body: { clientId: id } },
      false,
    )

    const parsed = clientSearchSchema.parse(data)

    const $ = cheerio.load(parsed.info)

    const { lines } = $.extract({
      lines: [{ selector: ".client-bar-parent > div" }],
    })

    const info = lines
      .flatMap((s) => [...s.matchAll(extractKeyValuesRegex)])
      .reduce(
        (acc, m) => {
          acc[m[1].trim().toLocaleLowerCase()] = String(m[2].trim())
          return acc
        },
        {} as Record<string, unknown>,
      )

    const parsedInfo = clientInfoSchema.parse(info)

    return parsedInfo
  }

  async getAgendaCSV() {
    const data = await this.makeRequest("pgj/exportAppointmentsToCSV", {
      method: "GET",
    })

    const csv = z.string().parse(data)

    const a = await parseCSV(csv, { columns: true, delimiter: ";" }).toArray()

    return a
      .map((d) => agendaAssignmentSchema.parse(d))
      .map(agendaAssignmentMapper)
  }
}

const extractKeyValuesRegex = /([A-Za-z\s-]+):\s*([^:]+?)(?=\s+[A-Za-z\s]+:|$)/g
