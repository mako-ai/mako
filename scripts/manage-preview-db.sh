#!/bin/bash
# manage-preview-db.sh
# 
# Manages ephemeral MongoDB databases for PR previews.
# Used when a PR has migration changes and needs an isolated database.
#
# Usage:
#   ./scripts/manage-preview-db.sh create <pr_number>
#   ./scripts/manage-preview-db.sh delete <pr_number>
#   ./scripts/manage-preview-db.sh list
#
# Environment:
#   STAGING_DATABASE_URL - MongoDB connection string for the staging cluster
#
# The script creates databases named: staging_pr_<number>

set -e

ACTION="${1:-}"
PR_NUMBER="${2:-}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_env() {
    if [ -z "$STAGING_DATABASE_URL" ]; then
        log_error "STAGING_DATABASE_URL environment variable is not set"
        exit 1
    fi
}

check_mongosh() {
    if ! command -v mongosh &> /dev/null; then
        log_error "mongosh is not installed. Install it from: https://www.mongodb.com/try/download/shell"
        exit 1
    fi
}

get_db_name() {
    echo "staging_pr_${PR_NUMBER}"
}

create_database() {
    local db_name=$(get_db_name)
    log_info "Creating ephemeral database: ${db_name}"
    
    # MongoDB creates databases implicitly when you insert data
    # We'll create a placeholder collection to ensure the database exists
    mongosh "$STAGING_DATABASE_URL" --quiet --eval "
        const db = db.getSiblingDB('${db_name}');
        db.createCollection('_pr_metadata');
        db._pr_metadata.insertOne({
            pr_number: ${PR_NUMBER},
            created_at: new Date(),
            type: 'ephemeral_preview'
        });
        print('Database ${db_name} created successfully');
    "
    
    log_info "Database created: ${db_name}"
    
    # Output the connection string for this database
    # Replace the database name in the URL
    local new_url=$(echo "$STAGING_DATABASE_URL" | sed "s|/[^/?]*\?|/${db_name}?|" | sed "s|/[^/?]*$|/${db_name}|")
    echo ""
    log_info "Connection string for PR #${PR_NUMBER}:"
    echo "$new_url"
}

delete_database() {
    local db_name=$(get_db_name)
    log_info "Deleting ephemeral database: ${db_name}"
    
    mongosh "$STAGING_DATABASE_URL" --quiet --eval "
        const db = db.getSiblingDB('${db_name}');
        db.dropDatabase();
        print('Database ${db_name} deleted successfully');
    "
    
    log_info "Database deleted: ${db_name}"
}

list_databases() {
    log_info "Listing all ephemeral PR databases..."
    
    mongosh "$STAGING_DATABASE_URL" --quiet --eval "
        const dbs = db.adminCommand({ listDatabases: 1 }).databases;
        const prDbs = dbs.filter(d => d.name.startsWith('staging_pr_'));
        
        if (prDbs.length === 0) {
            print('No ephemeral PR databases found');
        } else {
            print('Found ' + prDbs.length + ' ephemeral PR database(s):');
            prDbs.forEach(d => {
                const prNum = d.name.replace('staging_pr_', '');
                const sizeMB = (d.sizeOnDisk / 1024 / 1024).toFixed(2);
                print('  - PR #' + prNum + ' (' + d.name + ') - ' + sizeMB + ' MB');
            });
        }
    "
}

cleanup_stale() {
    log_info "Cleaning up stale ephemeral databases..."
    log_warn "This will delete databases for PRs that are no longer open"
    
    # This would require GitHub API access to check PR status
    # For now, just list what exists
    list_databases
    
    log_warn "Manual cleanup: Use 'delete <pr_number>' for databases you want to remove"
}

show_usage() {
    echo "Usage: $0 <action> [pr_number]"
    echo ""
    echo "Actions:"
    echo "  create <pr_number>  - Create an ephemeral database for a PR"
    echo "  delete <pr_number>  - Delete an ephemeral database for a PR"
    echo "  list                - List all ephemeral PR databases"
    echo "  cleanup             - Show stale databases (requires manual deletion)"
    echo ""
    echo "Environment:"
    echo "  STAGING_DATABASE_URL - MongoDB connection string (required)"
    echo ""
    echo "Examples:"
    echo "  $0 create 123       # Create database for PR #123"
    echo "  $0 delete 123       # Delete database for PR #123"
    echo "  $0 list             # List all PR databases"
}

# Main
case "$ACTION" in
    create)
        if [ -z "$PR_NUMBER" ]; then
            log_error "PR number is required for create action"
            show_usage
            exit 1
        fi
        check_env
        check_mongosh
        create_database
        ;;
    delete)
        if [ -z "$PR_NUMBER" ]; then
            log_error "PR number is required for delete action"
            show_usage
            exit 1
        fi
        check_env
        check_mongosh
        delete_database
        ;;
    list)
        check_env
        check_mongosh
        list_databases
        ;;
    cleanup)
        check_env
        check_mongosh
        cleanup_stale
        ;;
    *)
        show_usage
        exit 1
        ;;
esac

