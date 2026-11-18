package models

import (
	"context"

	"github.com/uptrace/bun"
	"gorm.io/gorm"
	"xorm.io/xorm"

	"orm/app/db"
)

// xorm

type Issue struct{ ID int64 }
type Comment struct{ ID int64 }
type Label struct{ ID int64 }
type IssueList []*Issue

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

type User struct{ ID int64 }
type Category struct{ ID int64 }

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
	ID            int64
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
