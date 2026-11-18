package models

import (
	"context"

	"github.com/uptrace/bun"
	"gorm.io/gorm"
	"xorm.io/xorm"

	"orm/app/db"
	"orm/app/timeutil"
)

// xorm

type Issue struct {
	ID          int64
	RepoID      int64       `xorm:"INDEX UNIQUE(s)"`
	Repo        *Repository `xorm:"-"` // names RepoID's table
	Index       int64       `xorm:"UNIQUE(s) 'idx'"`
	Title       string      `xorm:"name"`
	LabelID     int64       // label: a table by name
	MilestoneID int64       // no milestone table
	Created     timeutil.TimeStamp
	Pinned      bool `xorm:"-"`
	Stamps
	cache string
}

// Stamps is embedded: its fields are the model's.
type Stamps struct {
	UpdatedUnix timeutil.TimeStamp
}

type Comment struct {
	ID      int64 `xorm:"pk autoincr 'cid'"`
	IssueID int64
	Issue   *Issue `xorm:"-"`
	RepoID  int64  // no Repo field: Issue's says repo means repository
}

// Label's columns come from the DDL in labelSchema, not the struct.
type Label struct{ ID int64 }

const labelSchema = `CREATE TABLE label (
	id   INTEGER PRIMARY KEY,
	name TEXT NOT NULL UNIQUE
)`

type IssueList []*Issue

type Repository struct{ ID int64 }

func GetRepo(id int64) (*Repository, error) { return db.GetByID[Repository](id) }

// Unused is never a model: no table, no columns.
type Unused struct{ ID int64 }

type Source struct{ ID int64 }

func (Source) TableName() string { return "login_source" }

func GetIssueByID(id int64) (*Issue, error) {
	issue := new(Issue)
	_, err := db.GetEngine().ID(id).Get(issue)
	return issue, err
}

func CountIssues() (int64, error) {
	sess := db.GetEngine().Where("closed = ?", false)
	return sess.Count(new(Issue))
}

func ListIssues() (IssueList, error) {
	var issues IssueList
	err := db.GetEngine().Where("x").Find(&issues)
	return issues, err
}

func CreateIssue(issue *Issue) error {
	return db.Insert(issue, &Comment{})
}

func AddLabel(l *Label) error {
	_, err := db.GetEngine().Insert(l)
	return err
}

func GetSource(id int64) (*Source, error) { return db.GetByID[Source](id) }

func FindComments() ([]*Comment, error) { return db.Find[Comment]("x") }

func DeleteLabel(l *Label) error { return db.DeleteByBean(l) }

func UpdateIssueTitle(i *Issue) error {
	_, err := db.GetEngine().ID(i.ID).Cols("title").Update(i)
	return err
}

// gorm

type User struct {
	gorm.Model
	Name       string `gorm:"column:full_name;not null"`
	CategoryID uint   // plural convention: categories
	Category   *Category
	Secret     string `gorm:"-"`
	Ignored    string `gorm:"-:all"`
}

type Category struct {
	Code string `gorm:"primaryKey"`
	ID   int64
}

func GetUser(g *gorm.DB, id int64) (*User, error) {
	var u User
	g.Where("id = ?", id).First(&u)
	return &u, nil
}

func RenameUsers(g *gorm.DB) {
	g.Model(&User{}).Where("x").Updates(map[string]any{"name": "y"})
}

func AddCategory(g *gorm.DB, c *Category) { g.Create(c) }

func Totals(g *gorm.DB) {
	var out []struct{ N int }
	g.Table("order_totals").Scan(&out)
}

// bun

type Book struct {
	bun.BaseModel `bun:"table:library_books,alias:b"`
	ID            int64  `bun:",pk,autoincrement"`
	Title         string `bun:"book_title,notnull"`
	AuthorID      int64
	Author        *User `bun:"rel:belongs-to,join:author_id=id"`
	Draft         bool  `bun:"-"`
}

func ListBooks(ctx context.Context, b *bun.DB) ([]Book, error) {
	var books []Book
	err := b.NewSelect().Model(&books).Where("x").Scan(ctx)
	return books, err
}

func AddBook(ctx context.Context, b *bun.DB, book *Book) error {
	_, err := b.NewInsert().Model(book).Exec(ctx)
	return err
}

// not an ORM: a repo type with ORM-like method names

type Cache struct{}

func (Cache) Get(v any) bool   { return false }
func (Cache) Find(v any) error { return nil }

func Cached(c Cache) bool {
	var i Issue
	return c.Get(&i)
}

// Ctx is a repo struct passed to the chain's root, not a model.
type Ctx struct{ ID int64 }

func engineFor(*Ctx) db.Engine { return db.GetEngine() }

func CountLabels(c *Ctx) (int64, error) { return engineFor(c).Where("x").Count(new(Label)) }

// Stats reads into a row type declared in the function; Table names the table.
func Stats() error {
	type row struct{ N int }
	var rows []row
	return db.GetEngine().Where("x").Table("`issue` i").Find(&rows)
}

// ByCtx passes a context to a helper building the session; it isn't a bean.
type JobOpts struct{}

func (JobOpts) session(ctx context.Context) *xorm.Session { return db.GetEngine().Where("x") }

func RepoIDs(ctx context.Context) ([]int64, error) {
	var ids []int64
	return ids, JobOpts{}.session(ctx).Find(&ids)
}

// AppCtx is the repo's own context type, as in many web frameworks.
type AppCtx struct{ context.Context }

func CallsRepoIDs(c *AppCtx) { RepoIDs(c) }

// Raw SQL in a chain: the query says what it reads.
func MaxIssueID() (n int64, err error) {
	_, err = db.GetEngine().Where("x").SQL("SELECT max(id) FROM issue").Get(&n)
	return n, err
}

// A migration declares its own copy of a table; a local result row isn't a table.
func MigrateAddPinned() error {
	type Issue struct {
		ID     int64
		Pinned bool
	}
	type row struct{ N int }
	var rows []row
	if err := db.GetEngine().Where("x").Find(&rows); err != nil {
		return err
	}
	_, err := db.GetEngine().ID(1).Cols("pinned").Update(&Issue{})
	return err
}

func LabelIDs() ([]int64, error) { return db.FindIDs("label") }

// A helper builds the session; the model is in what it returns.
func issueQuery(repoID int64) *xorm.Session {
	return db.GetEngine().Where("repo_id = ?", repoID).Table(&Issue{})
}

func CountRepoIssues(repoID int64) (int64, error) { return issueQuery(repoID).Count() }
