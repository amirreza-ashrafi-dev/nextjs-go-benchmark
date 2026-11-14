package main

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

const (
	maxFileSize      = 50 << 20
	amountColumn     = 8 // Column I: Total Amount
	summarySheetName = "Summary"
)

type Summary struct {
	TotalRevenue      float64
	TotalTransactions int
	InvalidRows       int
}

// Read workbook rows using Excelize streaming.
func processWorkbook(f *excelize.File) (s Summary, err error) {
	for _, name := range f.GetSheetList() {
		if name == summarySheetName {
			continue
		}

		rows, err := f.Rows(name)
		if err != nil {
			return s, err
		}

		header := true

		for rows.Next() {
			cols, err := rows.Columns(excelize.Options{RawCellValue: true})
			if err != nil {
				rows.Close()
				return s, err
			}

			if len(cols) == 0 {
				continue
			}
			if header {
				header = false
				continue
			}
			if len(cols) <= amountColumn {
				s.InvalidRows++
				continue
			}

			raw := strings.ReplaceAll(strings.TrimSpace(cols[amountColumn]), ",", "")
			amount, err := strconv.ParseFloat(raw, 64)

			if raw == "" || err != nil || math.IsNaN(amount) || math.IsInf(amount, 0) {
				s.InvalidRows++
				continue
			}

			s.TotalRevenue += amount
			s.TotalTransactions++
		}

		if err := rows.Error(); err != nil {
			rows.Close()
			return s, err
		}
		if err := rows.Close(); err != nil {
			return s, err
		}
	}
	return s, nil
}

// Read one file from the XLSX ZIP package.
func readZipEntry(z *zip.Reader, name string) ([]byte, error) {
	for _, f := range z.File {
		if f.Name == name {
			r, err := f.Open()
			if err != nil {
				return nil, err
			}
			data, readErr := io.ReadAll(r)
			closeErr := r.Close()
			if readErr != nil {
				return nil, readErr
			}
			if closeErr != nil {
				return nil, closeErr
			}
			return data, nil
		}
	}
	return nil, fmt.Errorf("missing ZIP entry: %s", name)
}

// Insert XML immediately before a closing element.
func insertXML(data []byte, element, fragment string) ([]byte, error) {
	d := xml.NewDecoder(bytes.NewReader(data))

	for {
		token, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}

		end, ok := token.(xml.EndElement)
		if !ok || end.Name.Local != element {
			continue
		}

		pos := int(d.InputOffset())
		start := bytes.LastIndex(data[:pos], []byte("</"))
		if start < 0 {
			break
		}

		out := make([]byte, 0, len(data)+len(fragment))
		out = append(out, data[:start]...)
		out = append(out, fragment...)
		out = append(out, data[start:]...)
		return out, nil
	}
	return nil, fmt.Errorf("XML element %q not found", element)
}

func summaryXML(s Summary) []byte {
	return []byte(fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Metric</t></is></c><c r="B1" t="inlineStr"><is><t>Value</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>Total Revenue</t></is></c><c r="B2"><v>%s</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Total Transactions</t></is></c><c r="B3"><v>%d</v></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>Invalid Rows</t></is></c><c r="B4"><v>%d</v></c></row>
</sheetData>
</worksheet>`,
		strconv.FormatFloat(s.TotalRevenue, 'f', -1, 64),
		s.TotalTransactions,
		s.InvalidRows,
	))
}

// Add Summary directly to the XLSX ZIP package.
func addSummarySheet(input []byte, s Summary) ([]byte, error) {
	z, err := zip.NewReader(bytes.NewReader(input), int64(len(input)))
	if err != nil {
		return nil, err
	}

	wb, err := readZipEntry(z, "xl/workbook.xml")
	if err != nil {
		return nil, err
	}
	rels, err := readZipEntry(z, "xl/_rels/workbook.xml.rels")
	if err != nil {
		return nil, err
	}
	types, err := readZipEntry(z, "[Content_Types].xml")
	if err != nil {
		return nil, err
	}

	// Read existing sheet IDs and relationship IDs.
	var workbook struct {
		Sheets struct {
			Sheet []struct {
				Name string `xml:"name,attr"`
				ID   uint64 `xml:"sheetId,attr"`
			} `xml:"sheet"`
		} `xml:"sheets"`
	}
	if err := xml.Unmarshal(wb, &workbook); err != nil {
		return nil, err
	}

	var relationships struct {
		Items []struct {
			ID string `xml:"Id,attr"`
		} `xml:"Relationship"`
	}
	if err := xml.Unmarshal(rels, &relationships); err != nil {
		return nil, err
	}

	var maxSheetID uint64
	for _, sheet := range workbook.Sheets.Sheet {
		if sheet.Name == summarySheetName {
			return nil, errors.New("Summary sheet already exists")
		}
		if sheet.ID > maxSheetID {
			maxSheetID = sheet.ID
		}
	}

	// Find unused sheet filename.
	sheetNumber := 1
	for {
		found := false
		for _, f := range z.File {
			if f.Name == fmt.Sprintf("xl/worksheets/sheet%d.xml", sheetNumber) {
				found = true
				break
			}
		}
		if !found {
			break
		}
		sheetNumber++
	}

	sheetFile := fmt.Sprintf("sheet%d.xml", sheetNumber)
	sheetPath := "xl/worksheets/" + sheetFile

	// Find unused relationship ID.
	used := make(map[string]bool)
	for _, r := range relationships.Items {
		used[r.ID] = true
	}
	relNumber := 1
	for used[fmt.Sprintf("rId%d", relNumber)] {
		relNumber++
	}
	relID := fmt.Sprintf("rId%d", relNumber)

	// Update workbook.xml.
	wb, err = insertXML(wb, "sheets", fmt.Sprintf(
		`<sheet name="Summary" sheetId="%d" r:id="%s"/>`,
		maxSheetID+1, relID,
	))
	if err != nil {
		return nil, err
	}

	// Update workbook relationships.
	rels, err = insertXML(rels, "Relationships", fmt.Sprintf(
		`<Relationship Id="%s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/%s"/>`,
		relID, sheetFile,
	))
	if err != nil {
		return nil, err
	}

	// Update content types.
	types, err = insertXML(types, "Types", fmt.Sprintf(
		`<Override PartName="/%s" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
		sheetPath,
	))
	if err != nil {
		return nil, err
	}

	replacements := map[string][]byte{
		"xl/workbook.xml":            wb,
		"xl/_rels/workbook.xml.rels": rels,
		"[Content_Types].xml":        types,
	}

	var output bytes.Buffer
	zw := zip.NewWriter(&output)

	for _, f := range z.File {
		if data, ok := replacements[f.Name]; ok {
			writer, err := zw.CreateHeader(&f.FileHeader)
			if err != nil {
				zw.Close()
				return nil, err
			}
			if _, err := writer.Write(data); err != nil {
				zw.Close()
				return nil, err
			}
		} else if err := zw.Copy(f); err != nil {
			zw.Close()
			return nil, err
		}
	}

	writer, err := zw.Create(sheetPath)
	if err != nil {
		zw.Close()
		return nil, err
	}
	if _, err := writer.Write(summaryXML(s)); err != nil {
		zw.Close()
		return nil, err
	}

	if err := zw.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

// Next.js-integrated Go POST handler.
func POST(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxFileSize+(1<<20))
	multipartStart := time.Now()

	if err := r.ParseMultipartForm(8 << 20); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			http.Error(w, "Request too large", http.StatusRequestEntityTooLarge)
		} else {
			http.Error(w, "Failed to parse multipart form", http.StatusBadRequest)
		}
		return
	}
	multipartTime := time.Since(multipartStart)

	if r.MultipartForm != nil {
		defer r.MultipartForm.RemoveAll()
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "Missing file", http.StatusBadRequest)
		return
	}
	defer file.Close()

	if strings.ToLower(filepath.Ext(header.Filename)) != ".xlsx" {
		http.Error(w, "Only .xlsx files are supported", http.StatusBadRequest)
		return
	}
	if header.Size > maxFileSize {
		http.Error(w, "File exceeds 50 MB", http.StatusRequestEntityTooLarge)
		return
	}

	readStart := time.Now()
	input, err := io.ReadAll(file)
	if err != nil {
		http.Error(w, "Failed to read file", http.StatusBadRequest)
		return
	}
	readTime := time.Since(readStart)

	openStart := time.Now()
	book, err := excelize.OpenReader(bytes.NewReader(input))
	if err != nil {
		http.Error(w, "Invalid Excel workbook", http.StatusBadRequest)
		return
	}
	openTime := time.Since(openStart)

	processStart := time.Now()
	summary, err := processWorkbook(book)
	processTime := time.Since(processStart)

	closeErr := book.Close()
	if err != nil || closeErr != nil {
		http.Error(w, "Failed to process workbook", http.StatusInternalServerError)
		return
	}

	packageStart := time.Now()
	output, err := addSummarySheet(input, summary)
	packageTime := time.Since(packageStart)
	if err != nil {
		http.Error(w, "Failed to create Summary worksheet", http.StatusInternalServerError)
		return
	}

	log.Printf(
		"GO BENCHMARK | multipart=%v | input_read=%v | open=%v | process=%v | summary_package=%v | server_total=%v",
		multipartTime, readTime, openTime, processTime, packageTime, time.Since(start),
	)

	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", `attachment; filename="processed.xlsx"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(output)))
	w.Header().Set("X-Total-Revenue", strconv.FormatFloat(summary.TotalRevenue, 'f', 2, 64))
	w.Header().Set("X-Total-Transactions", strconv.Itoa(summary.TotalTransactions))
	w.Header().Set("X-Invalid-Rows", strconv.Itoa(summary.InvalidRows))

	if _, err := w.Write(output); err != nil {
		log.Printf("GO RESPONSE ERROR: %v", err)
	}
}
